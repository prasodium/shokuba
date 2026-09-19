import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, McpEndpoint, McpToolError } from './server'

interface Ctx {
  who: string
}

const echo = defineTool<Ctx, z.ZodObject<{ text: z.ZodString; times: z.ZodOptional<z.ZodNumber> }>>(
  {
    name: 'echo',
    description: 'Echo text back',
    input: z.object({ text: z.string().min(1), times: z.number().int().min(1).max(3).optional() }),
    handler: (args, ctx) => `${ctx.who}:${args.text.repeat(args.times ?? 1)}`,
  },
)
const explode = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
  name: 'explode',
  description: 'Always fails',
  input: z.object({}),
  handler: () => {
    throw new Error('secret internal detail: /Users/someone/db.sqlite')
  },
})
const refuse = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
  name: 'refuse',
  description: 'Fails on purpose, with a message for the model',
  input: z.object({}),
  handler: () => {
    throw new McpToolError('You have no task in progress.')
  },
})

const endpoint = new McpEndpoint<Ctx>(
  { name: 'shokuba', version: '1.2.3', instructions: 'Be careful.' },
  [echo, explode, refuse],
)
const ctx: Ctx = { who: 'mika' }
const call = (method: string, params?: unknown, id: string | number = 1) =>
  endpoint.handle({ jsonrpc: '2.0', id, method, params }, ctx)

describe('McpEndpoint', () => {
  it('answers initialize, echoing a version it supports', async () => {
    const reply = await call('initialize', { protocolVersion: '2025-03-26' })
    expect(reply).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'shokuba', version: '1.2.3' },
        instructions: 'Be careful.',
      },
    })
  })

  it('falls back to its newest version for one it does not know', async () => {
    const reply = await call('initialize', { protocolVersion: '1999-01-01' })
    expect(reply?.result).toMatchObject({ protocolVersion: '2025-06-18' })
  })

  it('never answers a notification', async () => {
    expect(
      await endpoint.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx),
    ).toBeNull()
  })

  it('answers ping', async () => {
    expect(await call('ping')).toMatchObject({ result: {} })
  })

  it('lists tools with JSON Schemas generated from their argument types', async () => {
    const reply = await call('tools/list')
    const tools = (
      reply?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
    ).tools
    expect(tools.map((t) => t.name)).toEqual(['echo', 'explode', 'refuse'])
    const schema = tools[0]?.inputSchema as {
      type: string
      required: string[]
      properties: Record<string, unknown>
      $schema?: string
    }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['text'])
    expect(Object.keys(schema.properties)).toEqual(['text', 'times'])
    expect(schema.$schema).toBeUndefined()
  })

  it("calls a tool with the caller's context, not anything from the message", async () => {
    const reply = await call('tools/call', { name: 'echo', arguments: { text: 'hi', times: 2 } })
    expect(reply?.result).toEqual({ content: [{ type: 'text', text: 'mika:hihi' }] })
    // Even if the message tries to say who it is, the context decides.
    const spoof = await call('tools/call', { name: 'echo', arguments: { text: 'x', who: 'ren' } })
    expect(spoof?.result).toEqual({ content: [{ type: 'text', text: 'mika:x' }] })
  })

  it('tells the model what was wrong with its arguments so it can retry', async () => {
    const reply = await call('tools/call', { name: 'echo', arguments: { times: 9 } })
    expect(reply?.result).toMatchObject({ isError: true })
    const text = (reply?.result as { content: Array<{ text: string }> }).content[0]?.text ?? ''
    expect(text).toContain('Invalid arguments')
    expect(text).toContain('text')
    expect(text).toContain('times')
  })

  it("shows a tool's deliberate message to the model as an error result, not a protocol error", async () => {
    const reply = await call('tools/call', { name: 'refuse' })
    expect(reply?.error).toBeUndefined()
    expect(reply?.result).toEqual({
      content: [{ type: 'text', text: 'You have no task in progress.' }],
      isError: true,
    })
  })

  it('does not leak the details of an unexpected failure', async () => {
    const reply = await call('tools/call', { name: 'explode' })
    expect(reply?.result).toEqual({
      content: [{ type: 'text', text: 'The tool failed.' }],
      isError: true,
    })
    expect(JSON.stringify(reply)).not.toContain('secret internal detail')
  })

  it('treats a missing arguments object as empty', async () => {
    const reply = await call('tools/call', { name: 'refuse' })
    expect(reply?.result).toMatchObject({ isError: true })
  })

  it('rejects unknown tools and methods with JSON-RPC errors', async () => {
    expect((await call('tools/call', { name: 'nope' }))?.error?.code).toBe(-32602)
    expect((await call('tools/call', {}))?.error?.code).toBe(-32602)
    expect((await call('resources/list'))?.error?.code).toBe(-32601)
  })

  it('rejects things that are not JSON-RPC', async () => {
    for (const bad of [
      null,
      'text',
      42,
      {},
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1 },
    ]) {
      const reply = await endpoint.handle(bad, ctx)
      expect(reply?.error?.code).toBe(-32600)
    }
  })

  it('keeps the request id, string or number', async () => {
    expect((await call('ping', undefined, 'abc'))?.id).toBe('abc')
    expect((await call('ping', undefined, 7))?.id).toBe(7)
  })
})

describe('tools only some callers may use', () => {
  const secret = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
    name: 'secret',
    description: 'Only for the boss',
    input: z.object({}),
    visibleTo: (who) => who.who === 'boss',
    handler: (_args, who) => `hello ${who.who}`,
  })
  const gated = new McpEndpoint<Ctx>({ name: 'shokuba', version: '1' }, [echo, secret])
  const as = (who: string, method: string, params?: unknown) =>
    gated.handle({ jsonrpc: '2.0', id: 1, method, params }, { who })
  const names = async (who: string): Promise<string[]> =>
    ((await as(who, 'tools/list'))?.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )

  it('are listed for those who may use them, and left out for everyone else', async () => {
    expect(await names('boss')).toEqual(['echo', 'secret'])
    expect(await names('mika')).toEqual(['echo'])
  })

  it('work for those who may use them', async () => {
    const reply = await as('boss', 'tools/call', { name: 'secret', arguments: {} })
    expect(reply?.result).toEqual({ content: [{ type: 'text', text: 'hello boss' }] })
  })

  it('answer as if they did not exist for everyone else, so nothing is revealed', async () => {
    const hidden = await as('mika', 'tools/call', { name: 'secret', arguments: {} })
    const missing = await as('mika', 'tools/call', { name: 'no-such-tool', arguments: {} })
    expect(hidden?.error?.message).toBe('Unknown tool "secret"')
    expect(hidden?.error?.code).toBe(missing?.error?.code)
    expect(hidden?.result).toBeUndefined()
  })
})
