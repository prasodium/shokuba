import { z } from 'zod'

/**
 * A minimal MCP server (JSON-RPC 2.0 over HTTP POST, "streamable HTTP" without streaming),
 * enough for an agent CLI to discover and call Shokuba's tools. Verified against the real
 * Claude Code 2.1.276: it sends `initialize`, `notifications/initialized`, `tools/list` and
 * `tools/call`, authenticating every request with a header.
 *
 * It is transport-agnostic: `handle()` takes one parsed message and returns the reply (or
 * null for a notification). The HTTP listener supplies authentication and the per-agent
 * context, so a tool always knows *which* agent is calling and cannot be told otherwise.
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

/** An error whose message is meant for the calling model to read and act on. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolError'
  }
}

export interface McpTool<Ctx> {
  name: string
  description: string
  /** JSON Schema for the arguments, generated from the tool's Zod schema. */
  inputSchema: Record<string, unknown>
  call(args: unknown, ctx: Ctx): Promise<string>
}

export function defineTool<Ctx, S extends z.ZodType>(definition: {
  name: string
  description: string
  input: S
  handler: (args: z.output<S>, ctx: Ctx) => string | Promise<string>
}): McpTool<Ctx> {
  // The `$schema` marker is noise to an MCP client; leave it out.
  const inputSchema = { ...(z.toJSONSchema(definition.input) as Record<string, unknown>) }
  delete inputSchema['$schema']
  return {
    name: definition.name,
    description: definition.description,
    inputSchema,
    async call(args, ctx) {
      const parsed = definition.input.safeParse(args ?? {})
      if (!parsed.success) {
        // Tell the model what was wrong so it can call again correctly.
        const problems = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
          .join('; ')
        throw new McpToolError(`Invalid arguments — ${problems}`)
      }
      return definition.handler(parsed.data, ctx)
    },
  }
}

const RequestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

const ERROR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
}

export interface McpServerInfo {
  name: string
  version: string
  /** Shown to the model when it connects. */
  instructions?: string
}

export class McpEndpoint<Ctx> {
  private readonly tools = new Map<string, McpTool<Ctx>>()

  constructor(
    private readonly info: McpServerInfo,
    tools: readonly McpTool<Ctx>[],
  ) {
    for (const tool of tools) this.tools.set(tool.name, tool)
  }

  /** Reply to one JSON-RPC message. `null` means "no reply" (a notification). */
  async handle(message: unknown, ctx: Ctx): Promise<JsonRpcResponse | null> {
    const parsed = RequestSchema.safeParse(message)
    if (!parsed.success) {
      return failure(null, ERROR.invalidRequest, 'Not a valid JSON-RPC 2.0 request')
    }
    const { id, method, params } = parsed.data
    // A message without an id is a notification: never answered.
    if (id === undefined) return null

    switch (method) {
      case 'initialize': {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        const protocolVersion =
          typeof requested === 'string' &&
          (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : SUPPORTED_VERSIONS[0]
        return success(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: this.info.name, version: this.info.version },
          ...(this.info.instructions && { instructions: this.info.instructions }),
        })
      }
      case 'ping':
        return success(id, {})
      case 'tools/list':
        return success(id, {
          tools: [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        })
      case 'tools/call': {
        const call = z
          .object({ name: z.string(), arguments: z.unknown().optional() })
          .safeParse(params)
        if (!call.success) return failure(id, ERROR.invalidParams, 'tools/call needs a tool name')
        const tool = this.tools.get(call.data.name)
        if (!tool) return failure(id, ERROR.invalidParams, `Unknown tool "${call.data.name}"`)
        try {
          const text = await tool.call(call.data.arguments, ctx)
          return success(id, { content: [{ type: 'text', text }] })
        } catch (error) {
          // A tool failing is a normal outcome the model should see and can act on — not a
          // protocol error. Only deliberate messages are shown; anything else stays generic.
          const text = error instanceof McpToolError ? error.message : 'The tool failed.'
          return success(id, { content: [{ type: 'text', text }], isError: true })
        }
      }
      default:
        return failure(id, ERROR.methodNotFound, `Method "${method}" is not supported`)
    }
  }
}

function success(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export const MCP_INTERNAL_ERROR = ERROR.internal
