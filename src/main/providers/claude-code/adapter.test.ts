import { describe, expect, it } from 'vitest'
import {
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
    workingDirectory: '/work/app',
    model: null,
    permissionMode: 'default' as const,
    ...overrides,
  },
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
      'mcp__shokuba__get_current_task,mcp__shokuba__submit_task,mcp__shokuba__report_blocked,mcp__shokuba__list_teammates,mcp__shokuba__send_message',
    ])
    const flag = launch.args.indexOf('--append-system-prompt')
    expect(launch.args[flag + 1]).toContain('You are Mika, Engineer')
    expect(launch.args.slice(-2)).toEqual(['--name', 'Mika'])
  })

  it("pre-approves only Shokuba's own three tools", () => {
    const allowed =
      adapter.buildLaunch(input()).args[
        adapter.buildLaunch(input()).args.indexOf('--allowedTools') + 1
      ]
    expect(allowed?.split(',').every((tool) => tool.startsWith('mcp__shokuba__'))).toBe(true)
    expect(allowed?.split(',')).toHaveLength(5)
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
