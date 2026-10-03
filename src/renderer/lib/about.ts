import type { GitHubStatus } from '@shared/github'
import type { AppInfo, GitInfo, ProviderInfo } from '@shared/ipc/api'
import { errorMessage } from './errors'
import type { Outcome } from './outcome'

export const PLATFORM_NAMES: Record<AppInfo['platform'], string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

/** The header pill: the version and the system it runs on, and nothing else. */
export function versionPill(info: Pick<AppInfo, 'version' | 'platform'>): string {
  return `v${info.version} · ${PLATFORM_NAMES[info.platform]}`
}

/** One fact found on this computer: what was found, and whether it is usable as it is. */
export interface Finding {
  label: string
  text: string
  ok: boolean
}

export function gitFinding(git: GitInfo): Finding {
  return git.state === 'ready'
    ? { label: 'Git', text: `${git.version} (needs ${git.minimum} or newer)`, ok: true }
    : { label: 'Git', text: git.reason, ok: false }
}

export function githubFinding(status: GitHubStatus): Finding {
  const label = 'GitHub (gh)'
  switch (status.state) {
    case 'ready':
      return { label, text: `Signed in as ${status.login}`, ok: true }
    case 'signed-out':
      return { label, text: 'Installed, not signed in. Run "gh auth login".', ok: false }
    case 'missing':
      return { label, text: 'Not found', ok: false }
    case 'error':
      return { label, text: status.message, ok: false }
  }
}

export function providerFinding(provider: ProviderInfo): Finding {
  const label = provider.displayName
  const { found, version, problem } = provider.installation
  if (provider.simulated) return { label, text: 'Built in, needs no AI account', ok: true }
  if (found && !problem) return { label, text: version ?? 'Found, version unknown', ok: true }
  return { label, text: problem ?? 'Not found', ok: false }
}

/** What the About dialog shows, each part read on its own so one failure does not hide the rest. */
export interface AboutFacts {
  git: Outcome<GitInfo>
  github: Outcome<GitHubStatus>
  providers: Outcome<ProviderInfo[]>
}

export interface AboutSource {
  git(): Promise<GitInfo>
  github(): Promise<GitHubStatus>
  providers(): Promise<ProviderInfo[]>
}

async function attempt<T>(read: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export async function loadAbout(source: AboutSource): Promise<AboutFacts> {
  const [git, github, providers] = await Promise.all([
    attempt(() => source.git()),
    attempt(() => source.github()),
    attempt(() => source.providers()),
  ])
  return { git, github, providers }
}
