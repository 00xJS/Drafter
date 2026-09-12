import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_MCP_URL, selectMode } from '../../mcp/server.mjs'

// The stdio server as Claude Desktop runs it: a real `node mcp/server.mjs`
// process, spoken to over stdin/stdout, proxying to a local stand-in for
// /api/mcp that answers each method the way the hosted endpoint would.

const SERVER = fileURLToPath(new URL('../../mcp/server.mjs', import.meta.url))
const TOKEN = `drft_${'t'.repeat(43)}`

const seen: { headers: IncomingHttpHeaders; body: any }[] = []
let stub: Server
let url = ''

beforeAll(async () => {
  stub = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push({ headers: req.headers, body })
      const reply = (status: number, payload?: unknown, type = 'application/json') => {
        res.writeHead(status, payload === undefined ? {} : { 'content-type': type })
        res.end(payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload))
      }
      if (Array.isArray(body)) return reply(200, body.filter(m => m.id !== undefined).map(m => ({ jsonrpc: '2.0', id: m.id, result: { echoed: m.method } })))
      if (body.id === undefined) return reply(202)
      const ok = (result: unknown) => reply(200, { jsonrpc: '2.0', id: body.id, result })
      switch (body.method) {
        case 'initialize':
          return ok({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'drafter', version: '3.0.0' } })
        case 'revoked':
          return reply(401, { error: 'invalid_token' })
        case 'busy':
          return reply(429, { error: 'rate_limited' })
        case 'broken':
          return reply(502, '<html>bad gateway</html>', 'text/html')
        case 'stream':
          return reply(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { streamed: true } })}\n\n`, 'text/event-stream')
        case 'slow':
          return // never answers
        default:
          return ok({ method: body.method })
      }
    })
  })
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', () => resolve()))
  url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api/mcp`
})

afterAll(() => {
  stub.closeAllConnections()
  stub.close()
})

function start(env: Record<string, string>) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', ...env } })
  const lines: any[] = []
  let stderr = ''
  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) lines.push(JSON.parse(line))
    }
  })
  child.stderr.on('data', d => {
    stderr += d
  })
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const send = (msg: unknown) => child.stdin.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n')
  /** The next `count` lines the server writes. */
  async function next(count = 1, timeoutMs = 8000) {
    const until = Date.now() + timeoutMs
    while (lines.length < count) {
      if (Date.now() > until) throw new Error(`no answer after ${timeoutMs} ms; stderr: ${stderr}`)
      await new Promise(r => setTimeout(r, 20))
    }
    return lines.splice(0, count)
  }
  return { child, send, next, lines, stderr: () => stderr, exited }
}

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

describe('mode selection', () => {
  it('proxies with a token, falls back to the deprecated service key, and warns with neither', () => {
    expect(selectMode({ DRAFTER_AGENT_TOKEN: TOKEN, SUPABASE_URL: 'x', SUPABASE_SERVICE_KEY: 'y' })).toBe('proxy')
    expect(selectMode({ SUPABASE_URL: 'x', SUPABASE_SERVICE_KEY: 'y' })).toBe('service')
    expect(selectMode({ SUPABASE_URL: 'x' })).toBe('unconfigured')
    expect(selectMode({})).toBe('unconfigured')
    expect(DEFAULT_MCP_URL).toBe('https://drafterz.netlify.app/api/mcp')
  })
})

describe('proxy mode', () => {
  it('forwards each line with the token, answers in order, stays quiet for notifications, and names the negotiated version', async () => {
    seen.length = 0
    const s = start({ DRAFTER_AGENT_TOKEN: TOKEN, DRAFTER_MCP_URL: url })
    s.send(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    const [init] = await s.next()
    expect(init).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'drafter', version: '3.0.0' } } })
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    s.send(rpc(2, 'tools/list'))
    s.send(rpc(3, 'ping'))
    const answers = await s.next(2)
    expect(answers.map(a => a.id)).toEqual([2, 3])
    expect(s.lines).toEqual([])

    expect(seen).toHaveLength(4)
    for (const r of seen) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(r.headers['content-type']).toBe('application/json')
      expect(r.headers.accept).toBe('application/json, text/event-stream')
      expect(r.headers['user-agent']).toBe('drafter-mcp-proxy/3')
    }
    expect(seen[0].headers['mcp-protocol-version']).toBeUndefined()
    expect(seen[2].headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(seen[1].body).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' })

    s.child.stdin.end()
    expect(await s.exited).toBe(0)
    expect(s.stderr()).not.toContain(TOKEN)
  })

  it('turns a 401 into -32001 naming Settings → Assistants, and other failures into -32002', async () => {
    const s = start({ DRAFTER_AGENT_TOKEN: TOKEN, DRAFTER_MCP_URL: url })
    s.send(rpc(1, 'revoked'))
    s.send(rpc(2, 'busy'))
    s.send(rpc(3, 'broken'))
    const [revoked, busy, broken] = await s.next(3)
    expect(revoked).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'Drafter rejected the token (revoked?) — create a new one in Drafter → Settings → Assistants' },
    })
    expect(busy.error.code).toBe(-32002)
    expect(busy.error.message).toMatch(/wait a minute/)
    expect(broken.error).toMatchObject({ code: -32002, message: 'Drafter could not answer (HTTP 502).' })
    s.child.stdin.end()
    await s.exited
  })

  it('reads an event-stream answer, and passes a batch through as one line', async () => {
    const s = start({ DRAFTER_AGENT_TOKEN: TOKEN, DRAFTER_MCP_URL: url })
    s.send(rpc(1, 'stream'))
    s.send([rpc(2, 'a'), { jsonrpc: '2.0', method: 'notifications/x' }, rpc(3, 'b')])
    const [streamed, batch] = await s.next(2)
    expect(streamed).toEqual({ jsonrpc: '2.0', id: 1, result: { streamed: true } })
    expect(batch).toEqual([
      { jsonrpc: '2.0', id: 2, result: { echoed: 'a' } },
      { jsonrpc: '2.0', id: 3, result: { echoed: 'b' } },
    ])
    s.child.stdin.end()
    await s.exited
  })

  it('gives up on a silent endpoint after the timeout, and on an unreachable one at once, with -32002', async () => {
    const slow = start({ DRAFTER_AGENT_TOKEN: TOKEN, DRAFTER_MCP_URL: url, DRAFTER_MCP_TIMEOUT_MS: '300' })
    slow.send(rpc(1, 'slow'))
    const [late] = await slow.next()
    expect(late.error.code).toBe(-32002)
    expect(late.error.message).toMatch(/no answer in 0 s|no answer in/)
    slow.child.stdin.end()
    await slow.exited

    const down = start({ DRAFTER_AGENT_TOKEN: TOKEN, DRAFTER_MCP_URL: 'http://127.0.0.1:9/api/mcp' })
    down.send(rpc(7, 'ping'))
    const [unreachable] = await down.next()
    expect(unreachable).toMatchObject({ id: 7, error: { code: -32002 } })
    expect(unreachable.error.message).toContain('http://127.0.0.1:9/api/mcp')
    down.child.stdin.end()
    await down.exited
  })

  it('answers everything queued before it exits, even when stdin closes first', async () => {
    const s = start({ DRAFTER_AGENT_TOKEN: TOKEN, DRAFTER_MCP_URL: url })
    for (let i = 1; i <= 5; i++) s.send(rpc(i, `m${i}`))
    s.child.stdin.end()
    expect(await s.exited).toBe(0)
    expect(s.lines.map(l => l.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('answers a line that is not JSON with a parse error', async () => {
    const s = start({ DRAFTER_AGENT_TOKEN: TOKEN, DRAFTER_MCP_URL: url })
    s.send('{ not json')
    expect(await s.next()).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }])
    s.child.stdin.end()
    await s.exited
  })
})

describe('without a token', () => {
  it('warns, still lists the tools, and every call says to set DRAFTER_AGENT_TOKEN', async () => {
    const s = start({})
    s.send(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))
    s.send(rpc(2, 'tools/list'))
    s.send(rpc(3, 'tools/call', { name: 'list_tasks', arguments: {} }))
    const [init, list, call] = await s.next(3)
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(list.result.tools.length).toBeGreaterThan(20)
    expect(call.result.isError).toBe(true)
    expect(call.result.content[0].text).toContain('set DRAFTER_AGENT_TOKEN')
    s.child.stdin.end()
    await s.exited
    expect(s.stderr()).toMatch(/DRAFTER_AGENT_TOKEN is not set/)
  })

  it('the service-key mode still works but says it is deprecated', async () => {
    const s = start({ SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_KEY: 'legacy-key' })
    s.send(rpc(1, 'ping'))
    expect(await s.next()).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
    s.child.stdin.end()
    await s.exited
    expect(s.stderr()).toContain(
      "drafter-mcp: DEPRECATED — service-key mode gives this process every account's data. Create a token in Drafter → Settings → Assistants and set DRAFTER_AGENT_TOKEN.",
    )
    expect(s.stderr()).not.toContain('legacy-key')
  })
})
