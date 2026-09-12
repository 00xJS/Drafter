import { describe, expect, it } from 'vitest'
import { DEADLINE_TEXT, OUT_OF_TIME_TEXT, PROTOCOL_VERSIONS, SCOPE_REFUSAL, SERVER_INFO, handleBody, handleMessage, hasInitialize, instructionsFor, negotiate } from '../../mcp/protocol.mjs'
import type { HandleOptions } from '../../mcp/protocol.mjs'
import { TOOLS, toolsFor } from '../../mcp/tools.mjs'
import type { ToolContext, ToolDef } from '../../mcp/tools.mjs'

// The protocol layer both transports share: version negotiation, the JSON-RPC
// rules (notifications, batches, errors), and the scope check that decides
// what a connection may see and call.

const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const note = (method: string) => ({ jsonrpc: '2.0', method })
const ALL = ['read', 'write', 'journal']

/** A context nothing should touch: any use of it fails the test. */
const untouchable = () => {
  throw new Error('the context was built')
}

function fakeTool(name: string, scope: 'read' | 'write' | 'journal', run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>): ToolDef {
  return { name, scope, description: name, annotations: {}, inputSchema: { type: 'object', properties: {} }, run }
}

describe('version negotiation', () => {
  it('echoes a version it speaks and answers anything else with its newest', () => {
    for (const v of PROTOCOL_VERSIONS) expect(negotiate(v)).toBe(v)
    expect(negotiate('1999-01-01')).toBe(PROTOCOL_VERSIONS[0])
    expect(negotiate(undefined)).toBe(PROTOCOL_VERSIONS[0])
  })

  it('does not advertise 2026-07-28, which drops initialize and needs header checks this server does not make', () => {
    expect(PROTOCOL_VERSIONS).not.toContain('2026-07-28')
    expect(PROTOCOL_VERSIONS).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
  })

  it('initialize returns the negotiated version, tools without list changes, and the instructions', async () => {
    const res = await handleMessage(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }), { scopes: ALL, ctx: untouchable, instructions: 'hello' })
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'drafter', version: '3.0.0' }, instructions: 'hello' },
    })
    expect(SERVER_INFO).toEqual({ name: 'drafter', version: '3.0.0' })
  })

  it('instructions state the user\'s zone, keep the journal private and ask before bulk changes', () => {
    const text = instructionsFor({ tz: 'Europe/London', scopes: ['read', 'write'] })
    expect(text).toContain('Europe/London')
    expect(text).toContain('Journal is personal writing — quote it only when asked.')
    expect(text).toContain('Ask before bulk changes')
    expect(text).not.toContain('read-only')
    expect(instructionsFor({ tz: 'UTC', scopes: ['read'] })).toContain('read-only')
  })

  it('knows an initialize anywhere in a body', () => {
    expect(hasInitialize(rpc(1, 'initialize'))).toBe(true)
    expect(hasInitialize([note('notifications/initialized'), rpc(2, 'initialize')])).toBe(true)
    expect(hasInitialize(rpc(1, 'tools/list'))).toBe(false)
  })
})

describe('JSON-RPC', () => {
  it('never answers a notification, and a body of only notifications is a 202', async () => {
    expect(await handleMessage(note('notifications/initialized'), {})).toBeNull()
    expect(await handleMessage({ jsonrpc: '2.0', id: null, method: 'ping' }, {})).toBeNull()
    expect(await handleBody(JSON.stringify(note('notifications/initialized')), {})).toEqual({ status: 202 })
    expect(await handleBody([note('notifications/initialized'), note('notifications/cancelled')], {})).toEqual({ status: 202 })
  })

  it('ignores a response a client sends', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', id: 7, result: {} }, {})).toBeNull()
    expect(await handleBody({ jsonrpc: '2.0', id: 7, error: { code: 1, message: 'x' } }, {})).toEqual({ status: 202 })
  })

  it('answers a batch in order, as an array, leaving out the notifications', async () => {
    const out = await handleBody([rpc('b', 'ping'), note('notifications/initialized'), rpc('a', 'tools/list'), rpc(3, 'nope')], { scopes: ['read'], ctx: untouchable })
    expect(out.status).toBe(200)
    const list = out.json as { id: unknown; result?: unknown; error?: { code: number } }[]
    expect(list.map(r => r.id)).toEqual(['b', 'a', 3])
    expect(list[0].result).toEqual({})
    expect(list[2].error?.code).toBe(-32601)
  })

  it('unknown methods are -32601; unparseable bodies -32700 with a null id; malformed messages -32600', async () => {
    expect((await handleMessage(rpc(1, 'resources/list'), {}))?.error).toEqual({ code: -32601, message: 'Method not found: resources/list' })
    expect(await handleBody('{"jsonrpc":', {})).toEqual({ status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } })
    expect((await handleBody('42', {})).status).toBe(400)
    expect((await handleBody('[]', {})).status).toBe(400)
    expect((await handleMessage({ id: 1, method: 'ping' }, {}))?.error?.code).toBe(-32600)
    expect((await handleMessage({ jsonrpc: '2.0', id: 1 }, {}))?.error?.code).toBe(-32600)
  })

  it('ping and tools/list never build the context (so the hosted endpoint mints no session for them)', async () => {
    const out = await handleBody([rpc(1, 'ping'), rpc(2, 'tools/list')], { scopes: ALL, ctx: untouchable })
    expect(out.status).toBe(200)
  })

  it('builds the context once however many calls a batch makes', async () => {
    let built = 0
    const echo = fakeTool('echo', 'read', async (_args, ctx) => ctx.userId)
    const opts: HandleOptions = { tools: [echo], scopes: ['read'], ctx: () => ({ userId: `u${++built}` }) as unknown as ToolContext }
    const out = await handleBody([rpc(1, 'tools/call', { name: 'echo' }), rpc(2, 'tools/call', { name: 'echo' })], opts)
    expect(built).toBe(1)
    expect((out.json as { result: { content: { text: string }[] } }[]).map(r => r.result.content[0].text)).toEqual(['"u1"', '"u1"'])
  })
})

describe('scopes', () => {
  const names = (scopes: string[]) => toolsFor(scopes).map(t => t.name)

  it('tools/list shows a connection only what its scopes allow', async () => {
    expect(names(['read'])).toContain('list_tasks')
    expect(names(['read'])).not.toContain('create_task')
    expect(names(['read'])).not.toContain('list_journal')
    expect(names(['read', 'write'])).toContain('create_task')
    expect(names(['read', 'write'])).not.toContain('add_journal_entry')
    expect(names(['read', 'journal'])).toEqual(expect.arrayContaining(['list_journal', 'add_journal_entry']))
    expect(names(ALL)).toHaveLength(TOOLS.length)
    const listed = await handleMessage(rpc(1, 'tools/list'), { scopes: ['read'], ctx: untouchable })
    expect(listed?.result.tools.map((t: { name: string }) => t.name)).toEqual(names(['read']))
  })

  it('tools/call refuses a tool outside the connection\'s scopes without running it', async () => {
    let ran = false
    const write = fakeTool('create_thing', 'write', async () => {
      ran = true
      return {}
    })
    const res = await handleMessage(rpc(1, 'tools/call', { name: 'create_thing', arguments: {} }), { tools: [write], scopes: ['read'], ctx: untouchable })
    expect(res?.result).toEqual({ content: [{ type: 'text', text: SCOPE_REFUSAL }], isError: true })
    expect(ran).toBe(false)
    const journal = await handleMessage(rpc(2, 'tools/call', { name: 'list_journal', arguments: {} }), { scopes: ['read', 'write'], ctx: untouchable })
    expect(journal?.result.isError).toBe(true)
    expect(journal?.result.content[0].text).toMatch(/Settings → Assistants/)
  })

  it('an unknown tool is -32602, and so are arguments that are not an object', async () => {
    expect((await handleMessage(rpc(1, 'tools/call', { name: 'rm_rf' }), { scopes: ALL }))?.error).toEqual({ code: -32602, message: 'Unknown tool: rm_rf' })
    expect((await handleMessage(rpc(2, 'tools/call', { name: 'list_tasks', arguments: [1] }), { scopes: ALL }))?.error?.code).toBe(-32602)
  })

  it('every tool names its scope, and the annotations say which only read, which delete and which repeat safely', () => {
    for (const t of TOOLS) {
      expect(['read', 'write', 'journal'], t.name).toContain(t.scope)
      const reads = /^(list|get)_/.test(t.name)
      expect(t.annotations.readOnlyHint, t.name).toBe(reads)
      expect(t.annotations.openWorldHint, t.name).toBe(false)
      if (t.scope === 'read') expect(reads, t.name).toBe(true)
    }
    const by = (n: string) => TOOLS.find(t => t.name === n)!
    expect(by('list_journal').scope).toBe('journal')
    expect(by('add_journal_entry').scope).toBe('journal')
    expect(by('delete_task').annotations.destructiveHint).toBe(true)
    expect(by('set_grocery_state').annotations.idempotentHint).toBe(true)
    expect(by('create_task').annotations.destructiveHint).toBe(false)
    const listed = toolsFor(ALL).find(t => t.name === 'delete_task')
    expect(listed?.annotations).toEqual(by('delete_task').annotations)
  })
})

describe('tool calls', () => {
  it('a tool\'s error is a result the model can read, not a protocol error', async () => {
    const boom = fakeTool('boom', 'read', async () => {
      throw new Error('No task with id "x".')
    })
    const res = await handleMessage(rpc(1, 'tools/call', { name: 'boom' }), { tools: [boom], scopes: ['read'], ctx: {} as ToolContext })
    expect(res?.result).toEqual({ content: [{ type: 'text', text: 'Error: No task with id "x".' }], isError: true })
  })

  it('a call past the deadline says a write may have landed; one that cannot start says nothing was written', async () => {
    const hang = fakeTool('hang', 'read', () => new Promise(() => {}))
    const late = await handleMessage(rpc(1, 'tools/call', { name: 'hang' }), { tools: [hang], scopes: ['read'], ctx: {} as ToolContext, deadlineMs: Date.now() + 30 })
    expect(late?.result).toEqual({ content: [{ type: 'text', text: DEADLINE_TEXT }], isError: true })
    let ran = false
    const quick = fakeTool('quick', 'read', async () => {
      ran = true
      return 1
    })
    const gone = await handleMessage(rpc(2, 'tools/call', { name: 'quick' }), { tools: [quick], scopes: ['read'], ctx: {} as ToolContext, deadlineMs: Date.now() - 1 })
    expect(gone?.result.content[0].text).toBe(OUT_OF_TIME_TEXT)
    expect(ran).toBe(false)
  })

  it('reports each call for logging by name and time, never with its arguments', async () => {
    const seen: unknown[] = []
    const echo = fakeTool('echo', 'read', async args => args)
    await handleMessage(rpc(1, 'tools/call', { name: 'echo', arguments: { secret: 'drft_shh' } }), { tools: [echo], scopes: ['read'], ctx: {} as ToolContext, onToolCall: c => seen.push(c) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'echo', isError: false })
    expect(JSON.stringify(seen)).not.toContain('drft_shh')
  })
})
