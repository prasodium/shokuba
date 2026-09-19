import { describe, expect, it } from 'vitest'
import { detectClaudeCode, editorBundleDirs, parseVersion } from './detect'

describe('parseVersion', () => {
  it('reads the version from `claude --version` output', () => {
    expect(parseVersion('2.1.276 (Claude Code)\n')).toBe('2.1.276')
    expect(parseVersion('1.0.0-beta.2 (Claude Code)')).toBe('1.0.0-beta.2')
  })

  it('returns null for anything else', () => {
    expect(parseVersion('command not found')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
})

describe('editorBundleDirs', () => {
  const listing: Record<string, string[]> = {
    '/home/u/.vscode/extensions': [
      'anthropic.claude-code-2.1.9-darwin-arm64',
      'anthropic.claude-code-2.1.276-darwin-arm64',
      'anthropic.claude-code-2.1.276-win32-x64',
      'ms-python.python-2024.1.0',
    ],
    '/home/u/.cursor/extensions': ['anthropic.claude-code-2.1.100-darwin-arm64'],
  }
  const listDir = async (dir: string): Promise<string[]> => {
    const entries = listing[dir]
    if (!entries) throw new Error('ENOENT')
    return entries
  }

  it('lists bundled binaries newest first, comparing versions numerically', async () => {
    expect(await editorBundleDirs('darwin', '/home/u', listDir)).toEqual([
      '/home/u/.vscode/extensions/anthropic.claude-code-2.1.276-darwin-arm64/resources/native-binary',
      '/home/u/.cursor/extensions/anthropic.claude-code-2.1.100-darwin-arm64/resources/native-binary',
      '/home/u/.vscode/extensions/anthropic.claude-code-2.1.9-darwin-arm64/resources/native-binary',
    ])
  })

  it('skips extension builds made for another OS', async () => {
    const dirs = await editorBundleDirs('linux', '/home/u', listDir)
    expect(dirs).toEqual([])
  })

  it('tolerates editors that are not installed', async () => {
    expect(await editorBundleDirs('darwin', '/nobody', listDir)).toEqual([])
  })
})

describe('detectClaudeCode', () => {
  const context = { platform: 'darwin' as const, env: { PATH: '/usr/bin' }, home: '/home/u' }
  const noEditors = async (): Promise<string[]> => {
    throw new Error('ENOENT')
  }

  it('reports found, with path and version', async () => {
    const result = await detectClaudeCode(context, {
      listDir: noEditors,
      find: async () => '/usr/local/bin/claude',
      readVersion: async () => '2.1.276',
    })
    expect(result).toEqual({
      found: true,
      path: '/usr/local/bin/claude',
      version: '2.1.276',
      problem: null,
    })
  })

  it('searches editor bundles in addition to PATH', async () => {
    let searched: readonly string[] | undefined
    await detectClaudeCode(context, {
      listDir: async () => ['anthropic.claude-code-2.1.276-darwin-arm64'],
      find: async (_name, options) => {
        searched = options.extraDirs
        return null
      },
    })
    expect(searched).toContain(
      '/home/u/.vscode/extensions/anthropic.claude-code-2.1.276-darwin-arm64/resources/native-binary',
    )
  })

  it('explains how to fix a missing install', async () => {
    const result = await detectClaudeCode(context, { listDir: noEditors, find: async () => null })
    expect(result.found).toBe(false)
    expect(result.problem).toMatch(/not found/i)
  })

  it('refuses Windows script shims with an actionable message', async () => {
    const result = await detectClaudeCode(
      { platform: 'win32', env: {}, home: 'C:\\Users\\u' },
      { listDir: noEditors, find: async () => 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd' },
    )
    expect(result.found).toBe(true)
    expect(result.problem).toMatch(/claude\.exe/)
  })

  it('never throws, even if searching fails', async () => {
    const result = await detectClaudeCode(context, {
      listDir: noEditors,
      find: async () => {
        throw new Error('disk on fire')
      },
    })
    expect(result.found).toBe(false)
    expect(result.problem).toContain('disk on fire')
  })
})
