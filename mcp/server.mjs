#!/usr/bin/env node
// Drafter's MCP server over stdio (newline-delimited JSON-RPC 2.0), for Claude
// Desktop, Claude Code and anything else that launches a local process.
// Zero dependencies, Node 18+. It chooses a mode when it starts:
//
//   DRAFTER_AGENT_TOKEN set               proxy: each line is POSTed to the hosted
//                                         /api/mcp (DRAFTER_MCP_URL, default
//                                         https://drafterz.netlify.app/api/mcp) and the
//                                         tools run there, as the token's user
//   SUPABASE_URL + SUPABASE_SERVICE_KEY   DEPRECATED: the tools run here with the
//                                         service key, which reads every account
//   neither                               a warning; tool calls say what to set
//
// Create a token in Drafter → Settings → Assistants. Claude Desktop:
//   {"mcpServers":{"drafter":{"command":"node","args":["<repo>/mcp/server.mjs"],"env":{"DRAFTER_AGENT_TOKEN":"drft_…"}}}}
//
// The tools live in tools.mjs, the protocol in protocol.mjs and the database
// access in data.mjs; this file is the transport and the mode.

import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createRestData } from './data.mjs'
import { SCOPES, TOOLS, createContext } from './tools.mjs'
import { SERVER_INFO, handleBody, instructionsFor } from './protocol.mjs'
import { makeClock } from '../shared/clock.mjs'

export const DEFAULT_MCP_URL = 'https://drafterz.netlify.app/api/mcp'
const USER_AGENT = 'drafter-mcp-proxy/3'
const TOKEN_REJECTED = 'Drafter rejected the token (revoked?) — create a new one in Drafter → Settings → Assistants'
const NOT_CONFIGURED = 'Drafter is not configured: set DRAFTER_AGENT_TOKEN (create a token in Drafter → Settings → Assistants).'
const DEPRECATED =
  "drafter-mcp: DEPRECATED — service-key mode gives this process every account's data. Create a token in Drafter → Settings → Assistants and set DRAFTER_AGENT_TOKEN.\n"

/** 'proxy' with a token, 'service' with the legacy service key, else 'unconfigured'. */
export function selectMode(env = process.env) {
  if (env.DRAFTER_AGENT_TOKEN) return 'proxy'
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) return 'service'
  return 'unconfigured'
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

/** The ids a body asks to be answered (notifications and responses have none to answer). */
function requestIds(parsed) {
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter(m => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null).map(m => m.id)
}

/** A data layer that refuses everything, for a server started with nothing configured. */
function unconfiguredData() {
  const refuse = async () => {
    throw new Error(NOT_CONFIGURED)
  }
  return { mode: 'service', userId: null, ownerId: refuse, fetchAll: refuse, fetchItem: refuse, fetchJournal: refuse, syncWrite: refuse, writeItem: refuse }
}

/** The tools run in this process: service-key mode, or unconfigured. */
function localHandler(mode, env) {
  const clock = makeClock() // the machine's zone
  const db =
    mode === 'service'
      ? createRestData({ baseUrl: env.SUPABASE_URL, mode: 'service', auth: async () => ({ apikey: env.SUPABASE_SERVICE_KEY, bearer: env.SUPABASE_SERVICE_KEY }) })
      : unconfiguredData()
  const opts = {
    tools: TOOLS,
    scopes: SCOPES,
    ctx: createContext({ db, clock, scopes: SCOPES }),
    serverInfo: SERVER_INFO,
    instructions: instructionsFor({ tz: clock.tz, scopes: SCOPES }),
  }
  return async parsed => {
    const r = await handleBody(parsed, opts)
    if (r.json) send(r.json)
  }
}

/** JSON-RPC messages in an HTTP answer: a JSON body, or the data lines of an event stream. */
function messagesIn(text, contentType) {
  if (/text\/event-stream/i.test(contentType ?? '')) {
    const out = []
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      try {
        out.push(JSON.parse(data))
      } catch {
        /* not a message */
      }
    }
    return out
  }
  try {
    const body = JSON.parse(text)
    const isRpc = m => m && typeof m === 'object' && m.jsonrpc === '2.0'
    return isRpc(body) || (Array.isArray(body) && body.length && body.every(isRpc)) ? [body] : []
  } catch {
    return []
  }
}

/** Proxy mode: the hosted endpoint runs the tools, as the token's user. */
function proxyHandler(env) {
  const url = env.DRAFTER_MCP_URL || DEFAULT_MCP_URL
  const token = env.DRAFTER_AGENT_TOKEN
  const timeoutMs = Number(env.DRAFTER_MCP_TIMEOUT_MS) || 30_000
  let protocolVersion = null
  return async (parsed, line) => {
    const ids = requestIds(parsed)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': USER_AGENT }
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion
    let res
    let text
    try {
      res = await fetch(url, { method: 'POST', headers, body: line, signal: AbortSignal.timeout(timeoutMs) })
      text = await res.text()
    } catch (e) {
      const why = e?.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : (e?.cause?.code ?? e?.message ?? String(e))
      for (const id of ids) send(rpcError(id, -32002, `Drafter could not be reached at ${url} (${why}). Check the connection and DRAFTER_MCP_URL.`))
      return
    }
    if (res.status === 202) return
    if (res.status === 401) {
      for (const id of ids) send(rpcError(id, -32001, TOKEN_REJECTED))
      return
    }
    const messages = messagesIn(text, res.headers.get('content-type'))
    if (!messages.length) {
      const why = res.status === 429 ? 'too many calls on this connection — wait a minute' : `HTTP ${res.status}`
      for (const id of ids) send(rpcError(id, -32002, `Drafter could not answer (${why}).`))
      return
    }
    for (const m of messages) {
      // later requests name the negotiated version, as Streamable HTTP asks
      for (const r of Array.isArray(m) ? m : [m]) {
        const asked = (Array.isArray(parsed) ? parsed : [parsed]).find(q => q?.method === 'initialize' && q.id === r?.id)
        if (asked && typeof r.result?.protocolVersion === 'string') protocolVersion = r.result.protocolVersion
      }
      send(m)
    }
  }
}

// Requests are processed strictly in arrival order: agents chain dependent
// calls (create → schedule → …), and concurrent read-modify-writes on the same
// post could otherwise race each other's last-write-wins stamps. The server
// also exits only after every queued request has been answered — stdin can
// close (e.g. when driven from a pipe) while tool calls are still running.
let pending = 0
let stdinClosed = false
let queue = Promise.resolve()

function maybeExit() {
  // flush stdout before exiting — process.exit() drops buffered pipe writes
  if (stdinClosed && pending === 0) process.stdout.write('', () => process.exit(0))
}

/** Serve MCP over stdio. Called only when this file is the entry point. */
export function startStdio(env = process.env) {
  const mode = selectMode(env)
  const handle = mode === 'proxy' ? proxyHandler(env) : localHandler(mode, env)
  if (mode === 'service') process.stderr.write(DEPRECATED)
  if (mode === 'unconfigured') process.stderr.write(`drafter-mcp: warning — DRAFTER_AGENT_TOKEN is not set; tool calls will fail. Create a token in Drafter → Settings → Assistants.\n`)

  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      send(rpcError(null, -32700, 'Parse error'))
      return
    }
    pending++
    queue = queue
      .then(() => handle(msg, trimmed))
      .catch(e => {
        // a rejected chain must never poison later requests or the process
        process.stderr.write(`drafter-mcp: handler error: ${e?.message ?? e}\n`)
      })
      .finally(() => {
        pending--
        maybeExit()
      })
  })
  rl.on('close', () => {
    stdinClosed = true
    maybeExit()
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startStdio()
