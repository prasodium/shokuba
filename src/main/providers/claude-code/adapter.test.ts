import { describe, expect, it } from 'vitest'
import type { TeamContext } from '../types'
import {
  agentSystemPrompt,
  claudeInheritedEnv,
  createClaudeCodeAdapter,
  MCP_CONFIG_FILE,
  SETTINGS_FILE,
} from './adapter'

const adapter = createClaudeCodeAdapter()

const input = (overrides: Partial<Parameters<typeof adapter.buildLaunch>[0]['employee']> = {}) => ({
  platform: 'darwin' as const,
  env: {},
  executable: '/usr/local/bin/claude',
  runDir: '/data/agents/e1',
  report: {
    url: 'http://127.0.0.1:9/hook',
    mcpUrl: 'http://127.0.0.1:9/mcp',
    tokenEnvVar: 'SHOKUBA_HOOK_TOKEN',
  },
  employee: {
    id: 'e1',
    name: 'Mika',
    role: 'Engineer',
    isManager: false,
    instructions: null,
    workingDirectory: '/work/app',
    model: null,
    permissionMode: 'default' as const,
    ...overrides,
  },
  team: { manager: null, reports: [] } as TeamContext,
})

describe('claude-code adapter', () => {
  it('is a real provider observed through hooks', () => {
    expect(adapter.id).toBe('claude-code')
    expect(adapter.capabilities.simulated).toBe(false)
    expect(adapter.observation).toMatchObject({ kind: 'hooks', source: 'reported' })
  })

  it('launches claude with the hook settings, the Shokuba tools, its role and a session name', () => {
    const launch = adapter.buildLaunch(input())
    expect(launch.file).toBe('/usr/local/bin/claude')
    expect(launch.args.slice(0, 6)).toEqual([
      '--settings',
      `/data/agents/e1/${SETTINGS_FILE}`,
      '--mcp-config',
      `/data/agents/e1/${MCP_CONFIG_FILE}`,
      '--allowedTools',
      'mcp__shokuba__get_current_task,mcp__shokuba__submit_task,mcp__shokuba__report_blocked,mcp__shokuba__list_teammates,mcp__shokuba__send_message,mcp__shokuba__get_current_review,mcp__shokuba__submit_review,mcp__shokuba__read_issue',
    ])
    const flag = launch.args.indexOf('--append-system-prompt')
    expect(launch.args[flag + 1]).toContain('You are Mika, Engineer')
    expect(launch.args.slice(-2)).toEqual(['--name', 'Mika'])
  })

  it("pre-approves only Shokuba's own tools: the five every agent has, the two a reviewer uses and the one that reads an issue", () => {
    const allowed =
      adapter.buildLaunch(input()).args[
        adapter.buildLaunch(input()).args.indexOf('--allowedTools') + 1
      ]
    expect(allowed?.split(',').every((tool) => tool.startsWith('mcp__shokuba__'))).toBe(true)
    expect(allowed?.split(',')).toHaveLength(8)
  })

  it("writes an MCP config that points at this agent's endpoint and takes the token from the environment", () => {
    const file = adapter.buildLaunch(input()).files.find((f) => f.name === MCP_CONFIG_FILE)
    const config = JSON.parse(file?.content ?? '{}') as {
      mcpServers: { shokuba: { type: string; url: string; headers: Record<string, string> } }
    }
    expect(config.mcpServers.shokuba).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bearer ${SHOKUBA_HOOK_TOKEN}' },
    })
  })

  it('passes the model and a non-default permission mode, and only then', () => {
    const launch = adapter.buildLaunch(input({ model: 'sonnet', permissionMode: 'plan' }))
    expect(launch.args).toEqual(
      expect.arrayContaining(['--model', 'sonnet', '--permission-mode', 'plan']),
    )
    expect(adapter.buildLaunch(input()).args).not.toContain('--permission-mode')
  })

  it('never offers to bypass permission checks', () => {
    expect(adapter.capabilities.permissionModes).not.toContain('bypassPermissions')
    const args = adapter.buildLaunch(input({ permissionMode: 'acceptEdits' })).args.join(' ')
    expect(args).not.toMatch(/dangerously|bypass/i)
  })

  it('writes settings that reference the env var for the token, never the token', () => {
    const [file] = adapter.buildLaunch(input()).files
    expect(file?.name).toBe(SETTINGS_FILE)
    const settings = JSON.parse(file?.content ?? '{}') as { hooks: Record<string, unknown> }
    expect(Object.keys(settings.hooks)).toContain('PreToolUse')
    expect(file?.content).toContain('Bearer $SHOKUBA_HOOK_TOKEN')
    expect(file?.content).toContain('http://127.0.0.1:9/hook')
  })

  it('uses Windows path rules for the settings path on Windows', () => {
    const launch = adapter.buildLaunch({
      ...input(),
      platform: 'win32',
      runDir: 'C:\\data\\agents\\e1',
    })
    expect(launch.args[1]).toBe(`C:\\data\\agents\\e1\\${SETTINGS_FILE}`)
  })

  it("inherits only its own auth and network variables from Shokuba's environment", () => {
    const names = adapter.buildLaunch(input()).inheritEnv ?? []
    expect(names).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY']),
    )
    // Unrelated credentials in the user's shell are never inherited.
    for (const other of [
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'SSH_AUTH_SOCK',
    ]) {
      expect(names).not.toContain(other)
    }
  })
})

describe('continuing an agent', () => {
  it('uses the top-level block decision Claude Code honours (the nested form is ignored)', () => {
    const reply = adapter.observation.continuation?.('do the next thing')
    expect(reply).toEqual({ decision: 'block', reason: 'do the next thing' })
    expect(JSON.stringify(reply)).not.toContain('hookSpecificOutput')
  })
})

describe("the agent's introduction", () => {
  const base = { name: 'Ren', role: 'Engineer', isManager: false, instructions: null }
  const nobody: TeamContext = { manager: null, reports: [] }

  it('says nothing about a team for someone who is not on one', () => {
    const text = agentSystemPrompt(base, nobody)
    expect(text).toContain('You are Ren, Engineer')
    expect(text).not.toContain('report to')
    expect(text).not.toContain('lead a team')
  })

  it('includes what the role is for', () => {
    const text = agentSystemPrompt({ ...base, instructions: 'You write the API.' }, nobody)
    expect(text).toContain('What your role is for: You write the API.')
  })

  it('tells an employee who their manager is, and to go through them rather than to the person', () => {
    const text = agentSystemPrompt(base, {
      manager: { name: 'Mira', role: 'Manager' },
      reports: [],
    })
    expect(text).toContain('You report to Mira (Manager)')
    expect(text).toContain('do not message the person you work for directly')
    expect(text).toContain('send it to Mira with send_message')
  })

  it('tells a manager they are the one who talks to the person, and who reports to them', () => {
    const text = agentSystemPrompt(
      { ...base, name: 'Mira', role: 'Manager', isManager: true },
      {
        manager: null,
        reports: [
          { name: 'Ren', role: 'Engineer' },
          { name: 'Sora', role: 'QA' },
        ],
      },
    )
    expect(text).toContain('you are the one who talks to the person you work for')
    expect(text).toContain('Ren (Engineer), Sora (QA) report to you')
  })

  it('handles a manager with no team yet', () => {
    const text = agentSystemPrompt({ ...base, isManager: true }, nobody)
    expect(text).toContain('Nobody reports to you yet; list_teammates shows who does')
  })

  it('pre-approves the planning tools for a manager only, and says what a manager may do with them', () => {
    const manager = adapter.buildLaunch({
      ...input({ isManager: true }),
      team: { manager: null, reports: [] },
    })
    const employee = adapter.buildLaunch(input())
    const allowed = (args: string[]): string => args[args.indexOf('--allowedTools') + 1] ?? ''
    expect(allowed(manager.args)).toContain('mcp__shokuba__draft_mission')
    expect(allowed(manager.args)).toContain('mcp__shokuba__add_task')
    expect(allowed(manager.args)).toContain('mcp__shokuba__send_message')
    expect(allowed(employee.args)).not.toContain('draft_mission')
    expect(allowed(employee.args)).toContain('mcp__shokuba__send_message')
    const prompt = manager.args[manager.args.indexOf('--append-system-prompt') + 1] ?? ''
    expect(prompt).toContain('draft_mission and add_task')
    expect(prompt).toContain('You cannot run it or accept anyone')
    expect(employee.args.join(' ')).not.toContain('draft_mission and add_task')
  })

  it('is what a launched agent is given', () => {
    const launch = adapter.buildLaunch({
      ...input(),
      team: { manager: { name: 'Mira', role: 'Manager' }, reports: [] },
    })
    const at = launch.args.indexOf('--append-system-prompt')
    expect(launch.args[at + 1]).toContain('You report to Mira')
  })
})

describe('refusing a tool call', () => {
  it('answers a PreToolUse with the deny decision Claude Code honours, and the reason it reads', () => {
    const reply = adapter.observation.deny?.('Shokuba paused you.')
    expect(reply).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Shokuba paused you.',
      },
    })
  })
})

describe('claudeInheritedEnv', () => {
  it('adds AWS settings only when Claude Code is set to use Bedrock', () => {
    expect(claudeInheritedEnv({}, 'darwin')).not.toContain('AWS_PROFILE')
    expect(claudeInheritedEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, 'darwin')).toEqual(
      expect.arrayContaining(['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_REGION']),
    )
    expect(claudeInheritedEnv({ CLAUDE_CODE_USE_BEDROCK: '0' }, 'darwin')).not.toContain(
      'AWS_PROFILE',
    )
  })

  it('adds Google settings only when Claude Code is set to use Vertex', () => {
    expect(claudeInheritedEnv({}, 'linux')).not.toContain('GOOGLE_APPLICATION_CREDENTIALS')
    expect(claudeInheritedEnv({ CLAUDE_CODE_USE_VERTEX: 'true' }, 'linux')).toContain(
      'GOOGLE_APPLICATION_CREDENTIALS',
    )
  })

  it('reads variable names case-insensitively on Windows', () => {
    expect(claudeInheritedEnv({ claude_code_use_bedrock: '1' }, 'win32')).toContain('AWS_PROFILE')
  })
})
