import { describe, expect, it } from 'vitest'
import {
  HOOK_EVENTS,
  buildHookSettings,
  classifyTool,
  clip,
  parseClaudeHook,
  summarizeTool,
} from './hooks'

describe('buildHookSettings', () => {
  const settings = buildHookSettings('http://127.0.0.1:5555/hook', 'SHOKUBA_HOOK_TOKEN') as {
    hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
  }

  it('subscribes to every hook event we understand, and nothing else', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  it('posts to the given url with a short timeout so a hung Shokuba cannot slow the agent', () => {
    const handler = settings.hooks['PreToolUse']?.[0]?.hooks[0]
    expect(handler).toMatchObject({ type: 'http', url: 'http://127.0.0.1:5555/hook', timeout: 2 })
  })

  it('authenticates through an environment variable, never a literal secret', () => {
    const handler = settings.hooks['Stop']?.[0]?.hooks[0]
    expect(handler?.['headers']).toEqual({ Authorization: 'Bearer $SHOKUBA_HOOK_TOKEN' })
    expect(handler?.['allowedEnvVars']).toEqual(['SHOKUBA_HOOK_TOKEN'])
  })
})

describe('parseClaudeHook', () => {
  it('maps the session and turn lifecycle', () => {
    expect(parseClaudeHook({ hook_event_name: 'SessionStart' })).toEqual([
      { kind: 'session-started' },
    ])
    expect(
      parseClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'secret prompt' }),
    ).toEqual([{ kind: 'turn-started' }])
    expect(parseClaudeHook({ hook_event_name: 'Stop', last_assistant_message: 'x' })).toEqual([
      { kind: 'turn-finished' },
    ])
    expect(parseClaudeHook({ hook_event_name: 'SessionEnd', reason: 'clear' })).toEqual([
      { kind: 'session-ended', reason: 'clear' },
    ])
  })

  it('does not carry prompt or answer text into signals', () => {
    const [signal] = parseClaudeHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'my password is hunter2',
    })
    expect(JSON.stringify(signal)).not.toContain('hunter2')
  })

  it('maps a tool start with its summary and activity', () => {
    const signals = parseClaudeHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      cwd: '/work/app',
      tool_input: { file_path: '/work/app/src/a.ts', old_string: 'SECRET', new_string: 'x' },
    })
    expect(signals).toEqual([
      {
        kind: 'tool-started',
        toolUseId: 'toolu_1',
        toolName: 'Edit',
        summary: 'Edit src/a.ts',
        activity: { state: 'coding', inferred: false },
      },
    ])
    expect(JSON.stringify(signals)).not.toContain('SECRET')
  })

  it('maps tool completion and failure', () => {
    expect(
      parseClaudeHook({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 't',
        duration_ms: 12.6,
      }),
    ).toEqual([
      { kind: 'tool-finished', toolUseId: 't', toolName: 'Bash', ok: true, durationMs: 13 },
    ])
    expect(parseClaudeHook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' })).toEqual([
      { kind: 'tool-finished', toolName: 'Bash', ok: false },
    ])
  })

  it('treats permission requests and permission notifications as needing a human', () => {
    expect(parseClaudeHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toEqual([
      { kind: 'attention', reason: 'permission', message: 'Needs permission to use Bash' },
    ])
    expect(
      parseClaudeHook({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'ok?',
      }),
    ).toEqual([{ kind: 'attention', reason: 'permission', message: 'ok?' }])
  })

  it('ignores the idle notification, since the turn already said the agent is idle', () => {
    expect(
      parseClaudeHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
    ).toEqual([])
  })

  it('reports a failed turn', () => {
    expect(parseClaudeHook({ hook_event_name: 'StopFailure', error: 'rate limited' })).toEqual([
      { kind: 'turn-failed', message: 'rate limited' },
    ])
  })

  it('yields nothing for unknown events, missing fields and non-objects — never throws', () => {
    expect(parseClaudeHook({ hook_event_name: 'SomethingNew' })).toEqual([])
    expect(parseClaudeHook({ hook_event_name: 'PreToolUse' })).toEqual([])
    expect(parseClaudeHook({})).toEqual([])
    expect(parseClaudeHook(null)).toEqual([])
    expect(parseClaudeHook('nope')).toEqual([])
    expect(parseClaudeHook({ hook_event_name: 42 })).toEqual([])
  })

  it('tolerates fields it does not know about (Claude Code adds them between versions)', () => {
    expect(parseClaudeHook({ hook_event_name: 'Stop', brand_new_field: { a: 1 } })).toEqual([
      { kind: 'turn-finished' },
    ])
  })
})

describe('classifyTool', () => {
  it('treats editing and reading tools as facts', () => {
    expect(classifyTool('Write', {})).toEqual({ state: 'coding', inferred: false })
    expect(classifyTool('Grep', {})).toEqual({ state: 'researching', inferred: false })
  })

  it('marks shell commands as our guess, and spots test runs', () => {
    expect(classifyTool('Bash', { command: 'ls -la' })).toEqual({ state: 'coding', inferred: true })
    for (const command of [
      'npm test',
      'npm run test -- --watch',
      'npx vitest run',
      'pytest -q',
      'cargo test',
      'go test ./...',
    ]) {
      expect(classifyTool('Bash', { command })).toEqual({ state: 'testing', inferred: true })
    }
  })

  it('does not mistake words that merely contain "test" for a test run', () => {
    expect(classifyTool('Bash', { command: 'cat latest.log' }).state).toBe('coding')
    expect(classifyTool('Bash', { command: 'git commit -m "add contest page"' }).state).toBe(
      'coding',
    )
  })

  it('falls back to thinking (as a guess) for tools it does not know', () => {
    expect(classifyTool('mcp__something__do', undefined)).toEqual({
      state: 'thinking',
      inferred: true,
    })
  })
})

describe('summarizeTool', () => {
  const summary = (tool_name: string, tool_input: Record<string, unknown>, cwd?: string) =>
    summarizeTool({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...(cwd && { cwd }) })

  it('shows paths relative to the working directory when inside it', () => {
    expect(summary('Read', { file_path: '/w/a/README.md' }, '/w/a')).toBe('Read README.md')
    expect(summary('Read', { file_path: '/elsewhere/x.md' }, '/w/a')).toBe('Read /elsewhere/x.md')
    expect(summary('Write', { file_path: 'C:\\w\\a\\src\\x.ts' }, 'C:\\w\\a')).toBe(
      'Edit src\\x.ts',
    )
  })

  it('is not fooled by a sibling directory sharing a prefix', () => {
    expect(summary('Read', { file_path: '/w/app-evil/x' }, '/w/app')).toBe('Read /w/app-evil/x')
  })

  it('describes commands, searches and fetches briefly', () => {
    expect(summary('Bash', { command: 'npm   test\n--silent' })).toBe('Run npm test --silent')
    expect(summary('Grep', { pattern: 'TODO' })).toBe('Search for TODO')
    expect(summary('WebFetch', { url: 'https://example.com/a/b?q=1' })).toBe('Fetch example.com')
    expect(summary('WebFetch', { url: 'not a url' })).toBe('Fetch a page')
  })

  it('truncates long commands', () => {
    expect(summary('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(200)
  })

  it('falls back to the tool name', () => {
    expect(summary('SomethingElse', {})).toBe('SomethingElse')
  })
})

describe('clip', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(clip('  a \n b  ', 10)).toBe('a b')
    expect(clip('abcdefghij', 5)).toBe('abcd…')
  })
})
