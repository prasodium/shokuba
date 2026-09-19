import { pathApi } from '../../platform'
import { parseClaudeHook } from '../claude-code/hooks'
import type { LaunchInput, LaunchSpec, ProviderAdapter } from '../types'
import { MOCK_AGENT_SCRIPT } from './script'

export const MOCK_SCRIPT_FILE = 'mock-agent.cjs'

/**
 * A stand-in provider for demos and tests. It launches a scripted program that reports
 * through the same hook format as Claude Code, but everything it produces is labelled
 * `simulated` — the UI never presents demo activity as a real agent's work.
 */
export function createMockAdapter(options: { stepMs?: number } = {}): ProviderAdapter {
  return {
    id: 'mock',
    displayName: 'Demo agent (simulated)',
    capabilities: { simulated: true, supportsModelSelection: false, permissionModes: ['default'] },
    observation: { kind: 'simulated', source: 'simulated', parse: parseClaudeHook },

    detect: async () => ({ found: true, path: process.execPath, version: 'demo', problem: null }),

    buildLaunch(input: LaunchInput): LaunchSpec {
      return {
        // Under Electron, process.execPath is the Electron binary; this flag makes it run as plain Node.
        file: process.execPath,
        args: [pathApi(input.platform).join(input.runDir, MOCK_SCRIPT_FILE)],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          SHOKUBA_HOOK_URL: input.report.url,
          ...(options.stepMs !== undefined && { SHOKUBA_MOCK_STEP_MS: String(options.stepMs) }),
        },
        files: [{ name: MOCK_SCRIPT_FILE, content: MOCK_AGENT_SCRIPT }],
      }
    },
  }
}
