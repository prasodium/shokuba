import { z } from 'zod'
import type { AgentSignal, ToolActivity } from '../types'

/**
 * The Claude Code hook events Shokuba subscribes to. Verified against Claude Code 2.1.x:
 * the hook JSON arrives as an HTTP POST body with `hook_event_name` and per-event fields.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const

/** Hook requests must never slow the agent: give up quickly if Shokuba is unresponsive. */
const HOOK_TIMEOUT_SECONDS = 2

/**
 * The `--settings` JSON that makes Claude Code report to Shokuba. Merged by Claude Code
 * with the user's own hooks, never replacing them. The bearer token is not in this file:
 * the header names an environment variable, which Claude Code fills in from the agent's
 * environment (and only for variables listed in `allowedEnvVars`).
 */
export function buildHookSettings(url: string, tokenEnvVar: string): Record<string, unknown> {
  const handler = {
    type: 'http',
    url,
    timeout: HOOK_TIMEOUT_SECONDS,
    headers: { Authorization: `Bearer $${tokenEnvVar}` },
    allowedEnvVars: [tokenEnvVar],
  }
  const hooks: Record<string, unknown> = {}
  for (const name of HOOK_EVENTS) hooks[name] = [{ hooks: [handler] }]
  return { hooks }
}

// Claude Code adds fields between versions, so unknown keys are fine; the ones we read are checked.
const HookPayloadSchema = z.looseObject({
  hook_event_name: z.string(),
  cwd: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  duration_ms: z.number().optional(),
  notification_type: z.string().optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
})
type HookPayload = z.infer<typeof HookPayloadSchema>

/** Translate one Claude Code hook payload into provider-neutral signals. */
export function parseClaudeHook(raw: unknown): AgentSignal[] {
  const parsed = HookPayloadSchema.safeParse(raw)
  if (!parsed.success) return []
  const hook = parsed.data

  switch (hook.hook_event_name) {
    case 'SessionStart':
      return [{ kind: 'session-started' }]
    case 'UserPromptSubmit':
      return [{ kind: 'turn-started' }]
    case 'PreToolUse': {
      if (!hook.tool_name) return []
      return [
        {
          kind: 'tool-started',
          ...(hook.tool_use_id && { toolUseId: hook.tool_use_id }),
          toolName: hook.tool_name,
          summary: summarizeTool(hook),
          activity: classifyTool(hook.tool_name, hook.tool_input),
        },
      ]
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (!hook.tool_name) return []
      return [
        {
          kind: 'tool-finished',
          ...(hook.tool_use_id && { toolUseId: hook.tool_use_id }),
          toolName: hook.tool_name,
          ok: hook.hook_event_name === 'PostToolUse',
          ...(hook.duration_ms !== undefined && { durationMs: Math.round(hook.duration_ms) }),
        },
      ]
    }
    case 'PermissionRequest':
      return [
        {
          kind: 'attention',
          reason: 'permission',
          message: hook.tool_name
            ? `Needs permission to use ${hook.tool_name}`
            : 'Needs permission',
        },
      ]
    case 'Notification': {
      // idle_prompt just means "waiting for you" after a finished turn; the turn already said so.
      if (hook.notification_type === 'permission_prompt') {
        return [
          {
            kind: 'attention',
            reason: 'permission',
            message: clip(hook.message ?? 'Needs permission', 200),
          },
        ]
      }
      return []
    }
    case 'Stop':
      return [{ kind: 'turn-finished' }]
    case 'StopFailure':
      return [
        {
          kind: 'turn-failed',
          message: clip(hook.error ?? hook.message ?? 'The turn failed', 200),
        },
      ]
    case 'SessionEnd':
      return [{ kind: 'session-ended', reason: hook.reason ?? 'unknown' }]
    default:
      return []
  }
}

const TEST_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|npx\s+(?:vitest|jest|playwright)|vitest|jest|pytest|mocha|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|rspec|phpunit)\b/i

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'])

/**
 * What a tool call implies about the agent's activity. Editing and reading tools say what
 * they do; a shell command could be anything, so that is a guess and is marked as one.
 */
export function classifyTool(
  toolName: string,
  input: Record<string, unknown> | undefined,
): ToolActivity {
  if (EDIT_TOOLS.has(toolName)) return { state: 'coding', inferred: false }
  if (READ_TOOLS.has(toolName)) return { state: 'researching', inferred: false }
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof input?.['command'] === 'string' ? input['command'] : ''
    return {
      state: TEST_COMMAND.test(command.slice(0, 500)) ? 'testing' : 'coding',
      inferred: true,
    }
  }
  return { state: 'thinking', inferred: true }
}

export function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

/** Path shown relative to the agent's working directory when it lies inside it. */
function shortPath(file: string, cwd: string | undefined): string {
  if (cwd && file.startsWith(cwd) && (file[cwd.length] === '/' || file[cwd.length] === '\\')) {
    return file.slice(cwd.length + 1)
  }
  return file
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A short human description of a tool call, e.g. "Edit src/app.ts" or "Run npm test". */
export function summarizeTool(hook: HookPayload): string {
  const name = hook.tool_name ?? 'tool'
  const input = hook.tool_input ?? {}
  const file = str(input['file_path']) ?? str(input['notebook_path'])

  if (file && (EDIT_TOOLS.has(name) || name === 'Read')) {
    return clip(`${name === 'Read' ? 'Read' : 'Edit'} ${shortPath(file, hook.cwd)}`, 200)
  }
  if (SHELL_TOOLS.has(name)) {
    const command = str(input['command'])
    return command ? clip(`Run ${command}`, 200) : 'Run a command'
  }
  if (name === 'Grep') return clip(`Search for ${str(input['pattern']) ?? 'text'}`, 200)
  if (name === 'Glob') return clip(`Find ${str(input['pattern']) ?? 'files'}`, 200)
  if (name === 'WebFetch') {
    const url = str(input['url'])
    try {
      return url ? `Fetch ${new URL(url).host}` : 'Fetch a page'
    } catch {
      return 'Fetch a page'
    }
  }
  if (name === 'WebSearch') return 'Search the web'
  if (name === 'Task' || name === 'Agent') {
    return clip(`Delegate: ${str(input['description']) ?? 'a subtask'}`, 200)
  }
  return name
}
