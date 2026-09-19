import { PERMISSION_MODES } from '@shared/employees'
import { getEnv, pathApi, type Env, type PlatformId } from '../../platform'
import type { LaunchInput, LaunchSpec, ProviderAdapter } from '../types'
import { detectClaudeCode, type DetectDeps } from './detect'
import { buildHookSettings, parseClaudeHook } from './hooks'

export const SETTINGS_FILE = 'claude-settings.json'

/** Claude Code's own account, endpoint and network settings. Not secrets meant for other tools. */
const ALWAYS_INHERITED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const

/** Only handed over when Claude Code has been switched to that cloud provider. */
const BEDROCK_INHERITED = [
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const
const VERTEX_INHERITED = [
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const

const isOn = (value: string | undefined): boolean =>
  value !== undefined && !/^(0|false|)$/i.test(value)

/**
 * Which of Shokuba's environment variables Claude Code needs to authenticate. Cloud
 * credentials (AWS, Google) are only included when Claude Code is configured to use that
 * cloud, so an unrelated AWS key in your shell is not passed to an agent.
 */
export function claudeInheritedEnv(env: Env, platform: PlatformId): string[] {
  return [
    ...ALWAYS_INHERITED,
    ...(isOn(getEnv(env, 'CLAUDE_CODE_USE_BEDROCK', platform)) ? BEDROCK_INHERITED : []),
    ...(isOn(getEnv(env, 'CLAUDE_CODE_USE_VERTEX', platform)) ? VERTEX_INHERITED : []),
  ]
}

/**
 * Claude Code, observed through its own hooks. The PTY is what a human sees; the hooks
 * are what Shokuba's state is built from. No terminal output is ever parsed.
 */
export function createClaudeCodeAdapter(deps: DetectDeps = {}): ProviderAdapter {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: {
      simulated: false,
      supportsModelSelection: true,
      permissionModes: PERMISSION_MODES,
    },
    observation: { kind: 'hooks', source: 'reported', parse: parseClaudeHook },
    detect: (context) => detectClaudeCode(context, deps),

    buildLaunch(input: LaunchInput): LaunchSpec {
      const { employee, runDir, report } = input
      const settingsFile = pathApi(input.platform).join(runDir, SETTINGS_FILE)
      const args = ['--settings', settingsFile, '--name', employee.name]
      if (employee.model) args.push('--model', employee.model)
      if (employee.permissionMode !== 'default')
        args.push('--permission-mode', employee.permissionMode)

      return {
        file: input.executable,
        args,
        env: {},
        inheritEnv: claudeInheritedEnv(input.env, input.platform),
        files: [
          {
            name: SETTINGS_FILE,
            content: JSON.stringify(buildHookSettings(report.url, report.tokenEnvVar), null, 2),
          },
        ],
      }
    },
  }
}
