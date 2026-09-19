import { findExecutable, pathApi } from '../../platform'
import { parseClaudeHook } from '../claude-code/hooks'
import type { LaunchInput, LaunchSpec, ProviderAdapter } from '../types'
import { MOCK_AGENT_SCRIPT } from './script'

export const MOCK_SCRIPT_FILE = 'mock-agent.cjs'

export interface MockAdapterOptions {
  /** Milliseconds per scripted step; tests and smoke runs use a small value. */
  stepMs?: number
  /** Overridable so tests can exercise the Windows lookup from any host. */
  find?: typeof findExecutable
}

/**
 * A stand-in provider for demos and tests. It launches a scripted program that reports
 * through the same hook format as Claude Code, but everything it produces is labelled
 * `simulated` — the UI never presents demo activity as a real agent's work.
 *
 * The program is a Node script. On macOS and Linux, Shokuba's own runtime (Electron run
 * as plain Node) hosts it. On Windows that does not work: `electron.exe` is a GUI-subsystem
 * program, so inside a pseudo-terminal it gets no console (nothing is printed, nothing is
 * read) and the script exits on its own. There a real `node.exe` on PATH is required, and
 * the provider says so when it is missing.
 */
export function createMockAdapter(options: MockAdapterOptions = {}): ProviderAdapter {
  const find = options.find ?? findExecutable

  return {
    id: 'mock',
    displayName: 'Demo agent (simulated)',
    capabilities: { simulated: true, supportsModelSelection: false, permissionModes: ['default'] },
    observation: { kind: 'simulated', source: 'simulated', parse: parseClaudeHook },

    async detect({ platform, env, home }) {
      if (platform !== 'win32') {
        return { found: true, path: process.execPath, version: 'demo', problem: null }
      }
      const node = await find('node', { platform, env, home })
      if (node) return { found: true, path: node, version: 'demo', problem: null }
      return {
        found: false,
        path: null,
        version: null,
        problem:
          'The demo agent needs Node.js on your PATH on Windows. Install Node.js, or use another provider.',
      }
    },

    buildLaunch(input: LaunchInput): LaunchSpec {
      return {
        file: input.executable,
        args: [pathApi(input.platform).join(input.runDir, MOCK_SCRIPT_FILE)],
        env: {
          // When the executable is Electron itself, this makes it behave as plain Node.
          ELECTRON_RUN_AS_NODE: '1',
          SHOKUBA_HOOK_URL: input.report.url,
          SHOKUBA_MCP_URL: input.report.mcpUrl,
          ...(options.stepMs !== undefined && { SHOKUBA_MOCK_STEP_MS: String(options.stepMs) }),
        },
        files: [{ name: MOCK_SCRIPT_FILE, content: MOCK_AGENT_SCRIPT }],
      }
    },
  }
}
