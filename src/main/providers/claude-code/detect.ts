import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import {
  findExecutable,
  isDirectlyLaunchable,
  pathApi,
  safeChildEnv,
  type Env,
  type PlatformId,
} from '../../platform'
import type { DetectContext, ProviderInstallation } from '../types'

const VERSION_TIMEOUT_MS = 5_000

/** Editors that ship Claude Code as a bundled native binary. */
const EDITOR_EXTENSION_DIRS = ['.vscode', '.vscode-insiders', '.cursor'] as const

export interface DetectDeps {
  find?: typeof findExecutable
  listDir?: (dir: string) => Promise<string[]>
  readVersion?: (file: string, platform: PlatformId, env: Env) => Promise<string | null>
}

/** "2.1.276 (Claude Code)" -> "2.1.276" */
export function parseVersion(output: string): string | null {
  const match = /^\s*(\d+\.\d+\.\d+[\w.+-]*)/.exec(output)
  return match?.[1] ?? null
}

/** Compare dotted numeric versions; anything unparsable sorts lowest. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Where an editor extension keeps its bundled `claude` binary, newest version first.
 * Entries look like `anthropic.claude-code-2.1.276-darwin-arm64`. Extensions built for
 * another OS are skipped.
 */
export async function editorBundleDirs(
  platform: PlatformId,
  home: string,
  listDir: (dir: string) => Promise<string[]>,
): Promise<string[]> {
  const p = pathApi(platform)
  const found: Array<{ version: string; dir: string }> = []

  for (const editor of EDITOR_EXTENSION_DIRS) {
    const root = p.join(home, editor, 'extensions')
    let entries: string[]
    try {
      entries = await listDir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const match = /^anthropic\.claude-code-(\d+\.\d+\.\d+)(?:-([a-z0-9]+)-[a-z0-9_]+)?$/.exec(
        entry,
      )
      if (!match) continue
      if (match[2] !== undefined && match[2] !== platform) continue
      found.push({
        version: match[1] ?? '0.0.0',
        dir: p.join(root, entry, 'resources', 'native-binary'),
      })
    }
  }

  return found.sort((a, b) => compareVersions(b.version, a.version)).map((entry) => entry.dir)
}

function runVersion(file: string, platform: PlatformId, env: Env): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      ['--version'],
      { env: safeChildEnv(platform, env), timeout: VERSION_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseVersion(stdout)),
    )
  })
}

/** Find the `claude` executable and read its version. Never throws. */
export async function detectClaudeCode(
  context: DetectContext,
  deps: DetectDeps = {},
): Promise<ProviderInstallation> {
  const { platform, env, home } = context
  const find = deps.find ?? findExecutable
  const listDir = deps.listDir ?? ((dir: string) => fs.readdir(dir))
  const readVersion = deps.readVersion ?? runVersion

  let executable: string | null
  try {
    const extraDirs = await editorBundleDirs(platform, home, listDir)
    executable = await find('claude', { platform, env, home, extraDirs })
  } catch (error) {
    return {
      found: false,
      path: null,
      version: null,
      problem: `Could not search for Claude Code: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!executable) {
    return {
      found: false,
      path: null,
      version: null,
      problem:
        'Claude Code was not found. Install it (https://claude.com/claude-code) and make sure `claude` runs in a terminal.',
    }
  }

  if (!isDirectlyLaunchable(platform, executable)) {
    return {
      found: true,
      path: executable,
      version: null,
      problem: `Found ${executable}, but Windows script shims (.cmd/.bat) cannot be launched directly. Install the native claude.exe build.`,
    }
  }

  return {
    found: true,
    path: executable,
    version: await readVersion(executable, platform, env),
    problem: null,
  }
}
