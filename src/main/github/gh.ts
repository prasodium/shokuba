import { findExecutable, pickEnv, safeChildEnv, type Env, type PlatformId } from '../platform'
import { redactString } from '../security/redact'
import { runProcess } from './process'

export type GhErrorCode =
  /** `gh` is not installed, or could not be started. */
  | 'missing'
  /** `gh` is not signed in to github.com. */
  | 'signed-out'
  | 'not-found'
  | 'forbidden'
  | 'rate-limited'
  | 'network'
  | 'timeout'
  /** GitHub answered with something that is not what was asked for. */
  | 'bad-response'
  | 'failed'

/** A problem using GitHub, with a message a person can read. `detail` is `gh`'s own words, for the log. */
export class GhError extends Error {
  constructor(
    readonly code: GhErrorCode,
    message: string,
    readonly detail: string = '',
  ) {
    super(message)
    this.name = 'GhError'
  }
}

/** Something that can run `gh` and give back what it printed. */
export interface GhRunner {
  run(args: readonly string[], options?: { input?: string }): Promise<string>
}

export interface GhCliOptions {
  platform: PlatformId
  /** Shokuba's own environment, filtered before `gh` sees it. */
  env: Env
  home: string
  /** Run this program instead of looking for `gh` (tests, and a development-only override). */
  executable?: string
  /** Arguments that go before every command (a test runs a script through Node). */
  prefixArgs?: readonly string[]
  timeoutMs?: number
  maxBytes?: number
  /** How `gh` is looked for when there is no `executable`. Tests replace it. */
  find?: (name: string) => Promise<string | null>
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * The variables `gh` needs to find the person's own login and reach GitHub, and nothing else:
 * where its settings live, the desktop keyring it may keep the login in, and the network settings
 * a company proxy needs. They are copied from Shokuba's environment. What is NOT here is as
 * important: no `GH_TOKEN`, `GITHUB_TOKEN` or anything like them, so `gh` can only use what the
 * person signed in with by running `gh auth login` themselves.
 */
const PASSED_THROUGH = [
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const

/**
 * The GitHub command-line tool, run the one careful way:
 *  - with an argument list and no shell;
 *  - with a minimal environment (see above), told never to ask a question, open a browser, check
 *    for updates or colour its output;
 *  - with a time and an output size limit;
 *  - and never to print or use a token: it is only ever asked to make a request, so the person's
 *    login stays inside `gh`.
 */
export class GhCli implements GhRunner {
  private readonly env: Record<string, string>
  private found: string | undefined

  constructor(private readonly options: GhCliOptions) {
    const extra: Record<string, string> = {
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      GH_BROWSER: '',
      NO_COLOR: '1',
      LC_ALL: 'C',
    }
    Object.assign(extra, pickEnv(options.platform, options.env, PASSED_THROUGH))
    this.env = safeChildEnv(options.platform, options.env, extra)
  }

  /** Where `gh` is, or null. Looked for again each time until it is found. */
  async locate(): Promise<string | null> {
    if (this.options.executable) return this.options.executable
    const find =
      this.options.find ??
      ((name: string) =>
        findExecutable(name, {
          platform: this.options.platform,
          env: this.options.env,
          home: this.options.home,
        }))
    this.found ??= (await find('gh')) ?? undefined
    return this.found ?? null
  }

  async run(args: readonly string[], options: { input?: string } = {}): Promise<string> {
    const file = await this.locate()
    if (!file) {
      throw new GhError(
        'missing',
        'The GitHub command-line tool (gh) was not found. Install it from https://cli.github.com and run “gh auth login”.',
      )
    }

    let result
    try {
      result = await runProcess(file, [...(this.options.prefixArgs ?? []), ...args], {
        env: this.env,
        cwd: this.options.home,
        input: options.input,
        maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES') {
        this.found = undefined
        throw new GhError('missing', 'The GitHub command-line tool (gh) could not be started.')
      }
      throw new GhError('failed', 'The GitHub command-line tool (gh) could not be run.')
    }

    if (result.timedOut) {
      throw new GhError('timeout', 'GitHub took too long to answer, so the request was stopped.')
    }
    if (result.truncated) {
      throw new GhError('bad-response', 'GitHub sent back more than Shokuba will read.')
    }
    if (result.code !== 0) throw interpretFailure(result.code, result.stderr, result.stdout)
    return result.stdout
  }
}

/** Turn a failed `gh` run into an error that says what to do about it. */
export function interpretFailure(code: number | null, stderr: string, stdout = ''): GhError {
  const said = redactString(`${stderr}\n${firstLineOf(stdout)}`)
  const detail = said.trim().slice(0, 1000)

  // `gh` exits with 4 when it needs a login.
  if (
    code === 4 ||
    /gh auth login|not logged in|HTTP 401|Bad credentials|authentication required/i.test(said)
  ) {
    return new GhError(
      'signed-out',
      'GitHub is not signed in on this computer. Run “gh auth login” in a terminal, then try again.',
      detail,
    )
  }
  if (/rate limit|HTTP 429|abuse detection|secondary rate/i.test(said)) {
    return new GhError(
      'rate-limited',
      'GitHub says there have been too many requests. Wait a little and try again.',
      detail,
    )
  }
  if (/HTTP 404|Not Found/i.test(said)) {
    return new GhError(
      'not-found',
      'GitHub could not find that. Either it does not exist, or the account signed in to gh cannot see it.',
      detail,
    )
  }
  if (/HTTP 403|Forbidden|Resource not accessible|must have (admin|write)/i.test(said)) {
    return new GhError(
      'forbidden',
      'GitHub says the account signed in to gh is not allowed to do that.',
      detail,
    )
  }
  if (
    /dial tcp|no such host|connection refused|network is unreachable|error connecting|i\/o timeout|TLS handshake|tls:|EOF|timed out/i.test(
      said,
    )
  ) {
    return new GhError(
      'network',
      'GitHub could not be reached. Check the internet connection and try again.',
      detail,
    )
  }
  return new GhError('failed', 'GitHub did not accept the request.', detail)
}

function firstLineOf(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.slice(0, 300) ?? ''
}
