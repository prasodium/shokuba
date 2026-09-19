import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from '../logging/logger'

const HOOK_PATH = '/hook'
const MCP_PATH = '/mcp'
/** Tool results (a big file read) can be large; anything beyond this is refused. */
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_CONNECTIONS = 128

export interface HookRegistration {
  /** Full URL the agent should POST its status reports to. */
  url: string
  /** Full URL of this agent's MCP endpoint (its tools). */
  mcpUrl: string
  /** Secret identifying this agent. Hand it to the child through its environment only. */
  token: string
  unregister(): void
}

export type ReportHandler = (body: unknown) => void

/** Answers one MCP (JSON-RPC) message; null means the message needs no reply. */
export type McpHandler = (message: unknown) => Promise<unknown | null>

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Receives the reports agents make about themselves (Claude Code's HTTP hooks), and hands
 * each one to the handler registered for that agent.
 *
 * Threat model: this listens on the loopback interface, so any program on the machine
 * can reach it. What it accepts is therefore locked down:
 *  - each running agent has its own random 256-bit token; without one, nothing is read;
 *  - the token travels in an `Authorization` header. A web page cannot send that to us
 *    without a CORS preflight, which this server never answers;
 *  - the `Host` header must be exactly our loopback address (defeats DNS rebinding);
 *  - JSON only, size-capped, with short timeouts;
 *  - a report can only ever *describe* an agent (a state change in the log). It cannot
 *    start a process, read a file or run a command.
 */
export class HookServer {
  private readonly server: Server
  private readonly registrations = new Map<
    string,
    { employeeId: string; handler: ReportHandler; mcp: McpHandler | undefined }
  >()
  private address: AddressInfo | undefined

  constructor(
    private readonly logger: Logger,
    private readonly maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  ) {
    this.server = createServer((request, response) => this.onRequest(request, response))
    this.server.maxConnections = MAX_CONNECTIONS
    this.server.headersTimeout = 5_000
    this.server.requestTimeout = 15_000
  }

  /** Bind to an ephemeral port on 127.0.0.1 (never `localhost`, which may resolve to ::1). */
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.address = this.server.address() as AddressInfo
  }

  get port(): number {
    if (!this.address) throw new Error('HookServer is not listening')
    return this.address.port
  }

  register(employeeId: string, handler: ReportHandler, mcp?: McpHandler): HookRegistration {
    const token = randomBytes(32).toString('base64url')
    const key = digest(token)
    this.registrations.set(key, { employeeId, handler, mcp })
    return {
      url: `http://127.0.0.1:${this.port}${HOOK_PATH}`,
      mcpUrl: `http://127.0.0.1:${this.port}${MCP_PATH}`,
      token,
      unregister: () => {
        this.registrations.delete(key)
      },
    }
  }

  async close(): Promise<void> {
    this.registrations.clear()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private onRequest(request: IncomingMessage, response: ServerResponse): void {
    const reject = (status: number): void => {
      response.writeHead(status, { 'content-type': 'text/plain', connection: 'close' })
      response.end()
      request.resume()
    }

    const path = request.url
    const isMcp = path === MCP_PATH
    // /hook takes POST only. /mcp takes POST, and GET only so it can be refused politely
    // (MCP clients probe for a streaming channel this server does not offer).
    if (path !== HOOK_PATH && !isMcp) return reject(404)
    if (request.method !== 'POST' && !(isMcp && request.method === 'GET')) return reject(404)
    if (request.headers.host !== `127.0.0.1:${this.port}`) return reject(403)

    const authorization = request.headers.authorization ?? ''
    const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    // Looked up by hash so the comparison never touches the secret itself.
    const registration = presented ? this.registrations.get(digest(presented)) : undefined
    if (!registration) return reject(401)

    if (request.method === 'GET') return reject(405)

    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return reject(415)
    }

    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > this.maxBodyBytes) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) return reject(413)

      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return reject(400)
      }

      if (isMcp) {
        const mcp = registration.mcp
        if (!mcp) return reject(404)
        mcp(body)
          .then((reply) => {
            if (reply === null) {
              response.writeHead(202)
              response.end()
              return
            }
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify(reply))
          })
          .catch((error: unknown) => {
            this.logger.error('mcp.handler.failed', {
              employeeId: registration.employeeId,
              message: error instanceof Error ? error.message : String(error),
            })
            response.writeHead(500, { 'content-type': 'text/plain' })
            response.end()
          })
        return
      }

      try {
        registration.handler(body)
      } catch (error) {
        // A failure handling one report must not become the agent's problem: answer 200
        // regardless, so Claude Code never treats Shokuba as a blocking hook failure.
        this.logger.error('hook.handler.failed', {
          employeeId: registration.employeeId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    request.on('error', () => undefined)
  }
}
