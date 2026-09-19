import { describe, expect, it } from 'vitest'
import { claudeInheritedEnv, createClaudeCodeAdapter, SETTINGS_FILE } from './adapter'

const adapter = createClaudeCodeAdapter()

const input = (overrides: Partial<Parameters<typeof adapter.buildLaunch>[0]['employee']> = {}) => ({
  platform: 'darwin' as const,
  env: {},
  executable: '/usr/local/bin/claude',
  runDir: '/data/agents/e1',
  report: { url: 'http://127.0.0.1:9/hook', tokenEnvVar: 'SHOKUBA_HOOK_TOKEN' },
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

  it('launches claude with the generated hook settings and a session name', () => {
    const launch = adapter.buildLaunch(input())
    expect(launch.file).toBe('/usr/local/bin/claude')
    expect(launch.args).toEqual([
      '--settings',
      `/data/agents/e1/${SETTINGS_FILE}`,
      '--name',
      'Mika',
    ])
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
