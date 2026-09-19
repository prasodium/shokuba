import { describe, expect, it } from 'vitest'
import { createMockAdapter, MOCK_SCRIPT_FILE } from './adapter'

const input = (platform: 'darwin' | 'win32' | 'linux', executable: string) => ({
  platform,
  env: {},
  executable,
  runDir: platform === 'win32' ? 'C:\\data\\agents\\e1' : '/data/agents/e1',
  report: {
    url: 'http://127.0.0.1:9/hook',
    mcpUrl: 'http://127.0.0.1:9/mcp',
    tokenEnvVar: 'SHOKUBA_HOOK_TOKEN',
  },
  employee: {
    id: 'e1',
    name: 'Mika',
    role: 'Engineer',
    workingDirectory: '/w',
    model: null,
    permissionMode: 'default' as const,
  },
})

describe('mock (demo) adapter', () => {
  it('is simulated, so everything it reports is labelled that way', () => {
    const adapter = createMockAdapter()
    expect(adapter.capabilities.simulated).toBe(true)
    expect(adapter.observation.source).toBe('simulated')
  })

  it("is hosted by Shokuba's own runtime on macOS and Linux", async () => {
    const adapter = createMockAdapter()
    for (const platform of ['darwin', 'linux'] as const) {
      const found = await adapter.detect({ platform, env: {}, home: '/h' })
      expect(found).toMatchObject({ found: true, path: process.execPath, problem: null })
    }
  })

  it('needs a real node.exe on Windows, because electron.exe has no console there', async () => {
    const adapter = createMockAdapter({ find: async () => 'C:\\Program Files\\nodejs\\node.exe' })
    expect(
      await adapter.detect({ platform: 'win32', env: {}, home: 'C:\\Users\\u' }),
    ).toMatchObject({
      found: true,
      path: 'C:\\Program Files\\nodejs\\node.exe',
    })
  })

  it('says so plainly when Node.js is missing on Windows', async () => {
    const adapter = createMockAdapter({ find: async () => null })
    const result = await adapter.detect({ platform: 'win32', env: {}, home: 'C:\\Users\\u' })
    expect(result.found).toBe(false)
    expect(result.problem).toMatch(/Node\.js/)
  })

  it('launches the executable it detected with the script and the report URL', () => {
    const launch = createMockAdapter({ stepMs: 25 }).buildLaunch(
      input('win32', 'C:\\Program Files\\nodejs\\node.exe'),
    )
    expect(launch.file).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(launch.args).toEqual([`C:\\data\\agents\\e1\\${MOCK_SCRIPT_FILE}`])
    expect(launch.env).toMatchObject({
      SHOKUBA_HOOK_URL: 'http://127.0.0.1:9/hook',
      SHOKUBA_MOCK_STEP_MS: '25',
    })
    expect(launch.files[0]?.name).toBe(MOCK_SCRIPT_FILE)
  })

  it('leaves the report token to the runtime: it is never part of the launch it builds', () => {
    const launch = createMockAdapter().buildLaunch(input('darwin', '/bin/node'))
    expect(Object.keys(launch.env)).not.toContain('SHOKUBA_HOOK_TOKEN')
  })

  it('can be continued the same way the real agent can, so the demo exercises the same path', () => {
    expect(createMockAdapter().observation.continuation?.('x')).toEqual({
      decision: 'block',
      reason: 'x',
    })
  })

  it('refuses a tool call the same way the real agent is refused', () => {
    expect(createMockAdapter().observation.deny?.('no')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'no',
      },
    })
  })
})
