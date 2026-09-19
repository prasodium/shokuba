import type { CheckStepInput } from '@shared/verification'

/** What a project's top level holds, read from the person's own checkout. */
export interface ProjectFiles {
  /** File and folder names at the top of the repository. */
  names: ReadonlySet<string>
  /** The text of package.json, if there is one. */
  packageJson: string | null
}

/**
 * The scripts that are worth suggesting, and what to call them. Only names from this list are
 * ever turned into a command, so a script name written into a repository cannot put anything
 * else on the command line.
 */
const SCRIPTS: ReadonlyArray<{ script: string; name: string }> = [
  { script: 'typecheck', name: 'Type check' },
  { script: 'type-check', name: 'Type check' },
  { script: 'lint', name: 'Lint' },
  { script: 'test', name: 'Test' },
  { script: 'build', name: 'Build' },
]

const NPM_PLACEHOLDER = /no test specified/

/**
 * Suggest checks from what a project holds. They are only suggestions: the person reads them,
 * edits them and chooses to save them, and nothing runs until they have.
 */
export function suggestChecks(project: ProjectFiles): CheckStepInput[] {
  const has = (name: string): boolean => project.names.has(name)
  const steps: CheckStepInput[] = []

  if (has('package.json')) {
    const manager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm'
    const install =
      manager === 'pnpm'
        ? 'pnpm install --frozen-lockfile'
        : manager === 'yarn'
          ? 'yarn install --frozen-lockfile'
          : has('package-lock.json')
            ? 'npm ci'
            : 'npm install'
    steps.push({
      kind: 'setup',
      name: 'Install dependencies',
      command: install,
      timeoutSeconds: 900,
    })

    const scripts = readScripts(project.packageJson)
    const seen = new Set<string>()
    for (const { script, name } of SCRIPTS) {
      const body = scripts[script]
      if (body === undefined || seen.has(name)) continue
      if (script === 'test' && NPM_PLACEHOLDER.test(body)) continue
      seen.add(name)
      const command =
        script === 'test' && manager === 'npm' ? 'npm test' : `${manager} run ${script}`
      steps.push({ kind: 'check', name, command })
    }
  }
  if (has('Cargo.toml')) steps.push({ kind: 'check', name: 'Test', command: 'cargo test' })
  if (has('go.mod')) steps.push({ kind: 'check', name: 'Test', command: 'go test ./...' })
  if (has('pyproject.toml') || has('pytest.ini') || has('tox.ini') || has('setup.cfg')) {
    steps.push({ kind: 'check', name: 'Test', command: 'python -m pytest' })
  }

  // Nothing worth running was found: do not suggest an install with nothing to check.
  return steps.some((step) => step.kind === 'check') ? steps : []
}

function readScripts(text: string | null): Record<string, string> {
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts
    if (typeof scripts !== 'object' || scripts === null) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(scripts)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}
