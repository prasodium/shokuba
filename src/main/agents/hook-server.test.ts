import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../logging/logger'
import { HookServer } from './hook-server'

let server: HookServer
const logs: string[] = []

beforeEach(async () => {
  logs.length = 0
  server = new HookServer(
    createLogger((_level, line) => logs.push(line)),
    1024,
  )
  await server.listen()
})

afterEach(async () => {
  await server.close()
})

interface Reply {
  status: number
  body: string
}

/** Raw request, so tests can set headers (Host, Content-Type) that fetch would not let them. */
function send(options: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<Reply> {
  const url = new URL(options.url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.method ?? 'POST',
        headers: options.headers,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

const json = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  ...extra,
})

describe('HookServer', () => {
  it('listens on the loopback interface only, on a real port', () => {
    expect(server.port).toBeGreaterThan(0)
    const { url } = server.register('e1', () => {})
    expect(url).toBe(`http://127.0.0.1:${server.port}/hook`)
  })

  it('hands an authenticated JSON report to the handler registered for that token', async () => {
    const received: unknown[] = []
    const { url, token } = server.register('e1', (body) => received.push(body))
    const reply = await send({
      url,
      headers: json(token),
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    })
    expect(reply).toEqual({ status: 200, body: '{}' })
    expect(received).toEqual([{ hook_event_name: 'Stop' }])
  })

  it("keeps agents apart: one agent's token only reaches its own handler", async () => {
    const a: unknown[] = []
    const b: unknown[] = []
    const regA = server.register('a', (body) => a.push(body))
    const regB = server.register('b', (body) => b.push(body))
    await send({ url: regA.url, headers: json(regA.token), body: '{"n":1}' })
    await send({ url: regB.url, headers: json(regB.token), body: '{"n":2}' })
    expect(a).toEqual([{ n: 1 }])
    expect(b).toEqual([{ n: 2 }])
  })

  it('issues a different, unguessable token every time', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => server.register('e', () => {}).token))
    expect(tokens.size).toBe(20)
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(40)
  })

  describe('rejects', () => {
    it('a request with no credentials', async () => {
      const { url } = server.register('e1', () => {})
      const reply = await send({ url, headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(reply.status).toBe(401)
    })

    it('a wrong token, without ever calling a handler', async () => {
      const received: unknown[] = []
      const { url } = server.register('e1', (body) => received.push(body))
      const reply = await send({ url, headers: json('not-the-token'), body: '{}' })
      expect(reply.status).toBe(401)
      expect(received).toEqual([])
    })

    it('a token that has been unregistered', async () => {
      const registration = server.register('e1', () => {})
      registration.unregister()
      const reply = await send({
        url: registration.url,
        headers: json(registration.token),
        body: '{}',
      })
      expect(reply.status).toBe(401)
    })

    it('a Host header that is not our loopback address (DNS rebinding)', async () => {
      const { url, token } = server.register('e1', () => {})
      const reply = await send({
        url,
        headers: json(token, { host: 'evil.example:80' }),
        body: '{}',
      })
      expect(reply.status).toBe(403)
    })

    it('other paths and methods', async () => {
      const { url, token } = server.register('e1', () => {})
      const base = url.replace('/hook', '')
      expect((await send({ url: `${base}/other`, headers: json(token), body: '{}' })).status).toBe(
        404,
      )
      expect((await send({ url, method: 'GET', headers: json(token) })).status).toBe(404)
      expect((await send({ url, method: 'PUT', headers: json(token), body: '{}' })).status).toBe(
        404,
      )
    })

    it('a body that is not declared as JSON', async () => {
      const { url, token } = server.register('e1', () => {})
      const reply = await send({
        url,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
        body: '{}',
      })
      expect(reply.status).toBe(415)
    })

    it('a body that is not valid JSON', async () => {
      const { url, token } = server.register('e1', () => {})
      const reply = await send({ url, headers: json(token), body: '{not json' })
      expect(reply.status).toBe(400)
    })

    it('a body over the size limit', async () => {
      const received: unknown[] = []
      const { url, token } = server.register('e1', (body) => received.push(body))
      const reply = await send({
        url,
        headers: json(token),
        body: JSON.stringify({ big: 'x'.repeat(4096) }),
      })
      expect(reply.status).toBe(413)
      expect(received).toEqual([])
    })
  })

  it('answers 200 even when the handler throws, so the agent is never blocked by Shokuba', async () => {
    const { url, token } = server.register('e1', () => {
      throw new Error('handler exploded')
    })
    const reply = await send({ url, headers: json(token), body: '{}' })
    expect(reply.status).toBe(200)
    expect(logs.join('\n')).toContain('handler exploded')
  })

  it('does not echo secrets into its logs', async () => {
    const { url, token } = server.register('e1', () => {
      throw new Error('boom')
    })
    await send({ url, headers: json(token), body: '{}' })
    expect(logs.join('\n')).not.toContain(token)
  })

  it('refuses port lookups before it is listening', async () => {
    const idle = new HookServer(createLogger(() => {}))
    expect(() => idle.port).toThrow(/not listening/)
    await idle.close()
  })

  describe('MCP endpoint', () => {
    const rpc = { jsonrpc: '2.0', id: 1, method: 'ping' }

    it("serves an authenticated agent's tool calls at its own /mcp URL", async () => {
      const seen: unknown[] = []
      const { mcpUrl, token } = server.register(
        'e1',
        () => {},
        async (message) => {
          seen.push(message)
          return { jsonrpc: '2.0', id: 1, result: { ok: true } }
        },
      )
      expect(mcpUrl).toBe(`http://127.0.0.1:${server.port}/mcp`)
      const reply = await send({ url: mcpUrl, headers: json(token), body: JSON.stringify(rpc) })
      expect(reply.status).toBe(200)
      expect(JSON.parse(reply.body)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
      expect(seen).toEqual([rpc])
    })

    it('answers a notification with 202 and no body', async () => {
      const { mcpUrl, token } = server.register(
        'e1',
        () => {},
        async () => null,
      )
      const reply = await send({
        url: mcpUrl,
        headers: json(token),
        body: '{"jsonrpc":"2.0","method":"x"}',
      })
      expect(reply).toEqual({ status: 202, body: '' })
    })

    it("needs a token like /hook does, and one agent's token never reaches another's tools", async () => {
      const a: unknown[] = []
      const b: unknown[] = []
      const regA = server.register(
        'a',
        () => {},
        async (m) => (a.push(m), null),
      )
      const regB = server.register(
        'b',
        () => {},
        async (m) => (b.push(m), null),
      )
      expect(
        (
          await send({
            url: regA.mcpUrl,
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(401)
      expect((await send({ url: regA.mcpUrl, headers: json('wrong'), body: '{}' })).status).toBe(
        401,
      )
      await send({ url: regA.mcpUrl, headers: json(regA.token), body: '{"n":1}' })
      await send({ url: regB.mcpUrl, headers: json(regB.token), body: '{"n":2}' })
      expect(a).toEqual([{ n: 1 }])
      expect(b).toEqual([{ n: 2 }])
    })

    it('applies the same Host, content-type, JSON and size rules', async () => {
      const { mcpUrl, token } = server.register(
        'e1',
        () => {},
        async () => null,
      )
      expect(
        (await send({ url: mcpUrl, headers: json(token, { host: 'evil.example:80' }), body: '{}' }))
          .status,
      ).toBe(403)
      expect(
        (
          await send({
            url: mcpUrl,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
            body: '{}',
          })
        ).status,
      ).toBe(415)
      expect((await send({ url: mcpUrl, headers: json(token), body: '{nope' })).status).toBe(400)
      expect(
        (
          await send({
            url: mcpUrl,
            headers: json(token),
            body: JSON.stringify({ big: 'x'.repeat(4096) }),
          })
        ).status,
      ).toBe(413)
    })

    it('politely refuses the streaming GET that MCP clients probe for, but only when authenticated', async () => {
      const { mcpUrl, token } = server.register(
        'e1',
        () => {},
        async () => null,
      )
      expect(
        (await send({ url: mcpUrl, method: 'GET', headers: { authorization: `Bearer ${token}` } }))
          .status,
      ).toBe(405)
      expect((await send({ url: mcpUrl, method: 'GET', headers: {} })).status).toBe(401)
    })

    it('does not exist for an agent registered without tools', async () => {
      const { mcpUrl, token } = server.register('e1', () => {})
      expect(
        (await send({ url: mcpUrl, headers: json(token), body: JSON.stringify(rpc) })).status,
      ).toBe(404)
    })

    it('answers 500, without details, if the tool layer throws', async () => {
      const { mcpUrl, token } = server.register(
        'e1',
        () => {},
        async () => {
          throw new Error('database on fire')
        },
      )
      const reply = await send({ url: mcpUrl, headers: json(token), body: JSON.stringify(rpc) })
      expect(reply.status).toBe(500)
      expect(reply.body).not.toContain('database on fire')
      expect(logs.join('\n')).toContain('database on fire')
    })

    it('stops serving an agent once it is unregistered', async () => {
      const registration = server.register(
        'e1',
        () => {},
        async () => null,
      )
      registration.unregister()
      expect(
        (await send({ url: registration.mcpUrl, headers: json(registration.token), body: '{}' }))
          .status,
      ).toBe(401)
    })
  })
})
