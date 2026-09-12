// MCP over JSON-RPC 2.0 with no transport attached: the local stdio server and
// the hosted /api/mcp both hand each message here. Tools only, stateless — no
// sessions, no server-to-client requests, nothing kept between messages.
//
// Protocol versions, newest first. 2025-03-26 is the one that mandates
// JSON-RPC batches; handleBody answers them in order. 2026-07-28 is not here:
// it removes initialize altogether (server/discover and a per-request _meta
// version instead), requires Mcp-Method / Mcp-Name headers to match the body,
// and a resultType on every result — a different protocol from this one. A
// 2026 client probes with server/discover, gets -32601, and falls back to
// initialize with one of these.

import { TOOLS, toolsFor } from './tools.mjs'

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const SERVER_INFO = { name: 'drafter', version: '3.0.0' }

export const SCOPE_REFUSAL = 'This connection is read-only (or has no journal access) — change it in Drafter → Settings → Assistants.'
export const DEADLINE_TEXT = 'Drafter took too long — a write may still have landed; re-read before retrying.'
export const OUT_OF_TIME_TEXT = 'Drafter ran out of time before starting this call — nothing was written; send it again.'

/** The requested version when this server speaks it, else the newest it does. */
export function negotiate(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
}

/** The `instructions` an initialize result carries: the user's zone, and how to treat their data. */
export function instructionsFor({ tz, scopes = [] } = {}) {
  const lines = [
    `Drafter is the user's home planner and journal: projects and tasks, people and places, meals and groceries${scopes.includes('journal') ? ', and their journal' : ''}.`,
    `The user's time zone is ${tz || 'UTC'}: "today", and every date given without a time, is a day in that zone.`,
    'Journal is personal writing — quote it only when asked.',
    'Ask before bulk changes (more than a handful of writes) and before deleting anything.',
  ]
  if (!scopes.includes('write')) lines.push('This connection is read-only: it can look things up but not change them.')
  return lines.join('\n')
}

/** Does this body (one message or a batch) contain an initialize request? */
export function hasInitialize(parsed) {
  return (Array.isArray(parsed) ? parsed : [parsed]).some(m => m && typeof m === 'object' && m.method === 'initialize')
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
const toolText = (text, isError) => ({ content: [{ type: 'text', text }], isError })

/** One context per opts object, built on first use (initialize with instructions, or a tool call). */
const contexts = new WeakMap()
function contextOf(opts) {
  if (typeof opts.ctx !== 'function') return Promise.resolve(opts.ctx)
  let pending = contexts.get(opts)
  if (!pending) {
    pending = Promise.resolve().then(() => opts.ctx())
    contexts.set(opts, pending)
  }
  return pending
}

function scopesOf(opts) {
  if (Array.isArray(opts.scopes)) return opts.scopes
  if (opts.ctx && typeof opts.ctx === 'object' && Array.isArray(opts.ctx.scopes)) return opts.ctx.scopes
  return []
}

const TIMED_OUT = Symbol('timed out')

function withDeadline(promise, deadlineMs) {
  let timer
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadlineMs - Date.now()))
  })
  // the call keeps running after the deadline; its eventual failure must not surface as unhandled
  promise.catch(() => {})
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

async function callTool(id, params, opts) {
  const tools = opts.tools ?? TOOLS
  const name = params?.name
  const tool = tools.find(t => t.name === name)
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`)
  const args = params?.arguments ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'Invalid params: arguments must be an object')
  // tools/list already hides it; a client that calls it anyway is refused here, not trusted
  if (!scopesOf(opts).includes(tool.scope)) return rpcResult(id, toolText(SCOPE_REFUSAL, true))
  const started = Date.now()
  let outcome
  if (opts.deadlineMs && started >= opts.deadlineMs) {
    outcome = toolText(OUT_OF_TIME_TEXT, true)
  } else {
    try {
      const ctx = await contextOf(opts)
      const running = Promise.resolve().then(() => tool.run(args, ctx))
      const value = opts.deadlineMs ? await withDeadline(running, opts.deadlineMs) : await running
      outcome = value === TIMED_OUT ? toolText(DEADLINE_TEXT, true) : toolText(JSON.stringify(value, null, 2), false)
    } catch (e) {
      outcome = toolText(`Error: ${e?.message ?? e}`, true)
    }
  }
  opts.onToolCall?.({ name, ms: Date.now() - started, isError: outcome.isError })
  return rpcResult(id, outcome)
}

/**
 * Answer one JSON-RPC message; null when nothing is owed (a notification, or
 * a response the client sent). opts:
 *   tools         the catalogue (default TOOLS)
 *   scopes        the connection's scopes (default ctx.scopes)
 *   ctx           the tool context, or a function building it — called at most once, never for ping or tools/list
 *   serverInfo    default SERVER_INFO
 *   instructions  a string, or (ctx) => string
 *   deadlineMs    epoch ms a tool call must finish by (the hosted endpoint's function limit)
 *   onToolCall({ name, ms, isError })  for logging: never the arguments
 */
export async function handleMessage(msg, opts = {}) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request: not a JSON-RPC message')
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  if (typeof method !== 'string') {
    // a client's answer to a server request (this server sends none) needs no reply
    if ('result' in msg || 'error' in msg) return null
    return rpcError(isRequest ? id : null, -32600, 'Invalid Request: no method')
  }
  // JSON-RPC: notifications are never answered, whatever their method
  if (!isRequest) return null
  if (msg.jsonrpc !== '2.0') return rpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0"')
  try {
    if (method === 'initialize') {
      const instructions = typeof opts.instructions === 'function' ? opts.instructions(await contextOf(opts)) : opts.instructions
      return rpcResult(id, {
        protocolVersion: negotiate(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: opts.serverInfo ?? SERVER_INFO,
        ...(instructions ? { instructions } : {}),
      })
    }
    if (method === 'ping') return rpcResult(id, {})
    if (method === 'tools/list') {
      const tools = toolsFor(scopesOf(opts), opts.tools ?? TOOLS)
      return rpcResult(id, { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) })
    }
    if (method === 'tools/call') return await callTool(id, params, opts)
    return rpcError(id, -32601, `Method not found: ${method}`)
  } catch (e) {
    return rpcError(id, -32603, `Internal error: ${e?.message ?? e}`)
  }
}

/**
 * Answer a whole body — raw text or already parsed, one message or a batch:
 *   { status: 200, json }  a response, or an array of them in request order
 *   { status: 202 }        only notifications or responses: nothing to say
 *   { status: 400, json }  unparseable (-32700) or not a JSON-RPC message
 */
export async function handleBody(body, opts = {}) {
  let parsed = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch {
      return { status: 400, json: rpcError(null, -32700, 'Parse error') }
    }
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { status: 400, json: rpcError(null, -32600, 'Invalid Request: empty batch') }
    const out = []
    for (const m of parsed) {
      const r = await handleMessage(m, opts)
      if (r) out.push(r)
    }
    return out.length ? { status: 200, json: out } : { status: 202 }
  }
  if (!parsed || typeof parsed !== 'object') return { status: 400, json: rpcError(null, -32600, 'Invalid Request: not a JSON-RPC message') }
  const r = await handleMessage(parsed, opts)
  return r ? { status: 200, json: r } : { status: 202 }
}
