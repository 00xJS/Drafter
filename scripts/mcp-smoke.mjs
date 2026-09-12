#!/usr/bin/env node
// End-to-end smoke test for Drafter's MCP layer, against a real Postgres with
// every migration applied:
//
//   1. the deprecated local mode — the real `node mcp/server.mjs` over stdio
//      with the service key — every tool, and a household peer's personal
//      rows kept out of every answer;
//   2. the hosted endpoint — the real /api/mcp and OAuth handlers from
//      netlify/functions/lib, served over node:http — reached directly, and
//      through the same server.mjs in proxy mode (DRAFTER_AGENT_TOKEN), acting
//      as the token's user through the database's own policies.
//
// Why this exists: `npm run db:smoke` proves the SQL layer and the vitest
// suites prove the fetch contracts against stubs, but only this drives the
// actual servers against an actual database. Both September bugs — syncWrite
// not unwrapping { items, rejected }, and the ambiguous `id` in sync_posts
// making every write rejected — would have been caught by the first write.
//
// There is no PostgREST or GoTrue binary on this machine, so this file *is*
// both shims: a node:http server that implements exactly the requests the
// servers make, translates each into SQL and runs it through psql as the role
// the bearer maps to — the service key as service_role, a minted session
// (`user:<uuid>`) as authenticated with that user's JWT claims — and a small
// auth stand-in for the admin lookup, generate_link and verify. Anything it
// does not implement answers 501 with the path; a silent empty array would
// hide the class of bug this test exists to catch.
//
// Run with `npm run mcp:smoke`. Needs the PostgreSQL binaries on PATH; not
// part of `npm run check` (Netlify has no Postgres).

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = '00000000-0000-0000-0000-00000000000a'
const OWNER_EMAIL = 'owner@example.test'
const SERVICE_KEY = 'smoke-test-service-key'
const ANON_KEY = 'smoke-test-anon-key'
const MACHINE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
/** supabase/config.toml [api] max_rows: PostgREST never returns more rows than this in one response. */
const MAX_ROWS = 1000

const sha256 = s => createHash('sha256').update(s).digest('hex')

// ---------------------------------------------------------------------------
// Throwaway database (scripts/lib/pgtest.sh — the same loop db:smoke runs)
// ---------------------------------------------------------------------------

let dbDir = ''
let dbPort = ''

function startDatabase() {
  let out
  try {
    out = execFileSync('bash', [join(ROOT, 'scripts/lib/pgtest.sh'), 'up'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } catch (e) {
    if (e.status === 2) process.exit(2) // no Postgres on PATH; pgtest.sh said so
    throw new Error('mcp-smoke: could not start the throwaway Postgres')
  }
  dbDir = /^DIR=(.*)$/m.exec(out)?.[1] ?? ''
  dbPort = /^PORT=(.*)$/m.exec(out)?.[1] ?? ''
  if (!dbDir || !dbPort) throw new Error(`mcp-smoke: pgtest.sh up printed no DIR/PORT:\n${out}`)
}

function stopDatabase() {
  if (!dbDir) return
  const dir = dbDir
  dbDir = ''
  try {
    execFileSync('bash', [join(ROOT, 'scripts/lib/pgtest.sh'), 'down', dir], { stdio: 'ignore' })
  } catch {
    /* best effort: the temp dir is disposable */
  }
}

let queryCount = 0

/**
 * One SQL statement, returning its single value as text. `role` is the role to
 * run as (service_role for the service key, authenticated for a user's
 * session, whose JWT claims go in `claims`); the test's own seeding and
 * verification run as the superuser so no grant or policy can mask a row. The
 * result is captured with `\o` so psql's command tags can never contaminate it.
 */
function psqlValue(sql, role = null, claims = null) {
  const n = queryCount++
  const qfile = join(dbDir, `q${n}.sql`)
  const ofile = join(dbDir, `q${n}.out`)
  const prelude = `${claims ? `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, false);\n` : ''}${role ? `set role ${role};\n` : ''}`
  writeFileSync(qfile, `${prelude}\\o ${ofile}\n${sql};\n`)
  const r = spawnSync('psql', ['-h', dbDir, '-p', dbPort, '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', qfile], {
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout || '').trim()}\n  sql: ${sql.slice(0, 400)}`)
  return readFileSync(ofile, 'utf8').trim()
}

const psqlJson = sql => JSON.parse(psqlValue(sql) || 'null')

/** A single-quoted SQL literal. */
const lit = v => `'${String(v).replace(/'/g, "''")}'`

/** A JSON value as a dollar-quoted literal, with a tag the payload cannot contain. */
function jsonLit(value) {
  const s = JSON.stringify(value)
  let tag = 'shim'
  while (s.includes(`$${tag}$`)) tag += 'x'
  return `$${tag}$${s}$${tag}$`
}

/** Seed the owner exactly as db-smoke-assert.sql does: an auth user and the owner_email config row. */
function seedOwner() {
  psqlValue(`insert into auth.users (id, email) values (${lit(OWNER)}, ${lit(OWNER_EMAIL)}) on conflict do nothing`)
  psqlValue(`insert into public.app_config (key, value) values ('owner_email', ${lit(OWNER_EMAIL)})
             on conflict (key) do update set value = excluded.value`)
}

/** Store rows the MCP server has no tool to create (a person, a recipe), through the real RPC. */
function seedRows(items) {
  const res = JSON.parse(psqlValue(`select public.sync_posts(${jsonLit(items)}::jsonb, '2099-01-01')`, 'service_role'))
  if (res.rejected?.length) throw new Error(`mcp-smoke: seed rows rejected: ${res.rejected.join(', ')}`)
}

// ---------------------------------------------------------------------------
// A household peer (the second member db-smoke-assert.sql seeds), to prove the
// server keeps their personal rows to themselves
// ---------------------------------------------------------------------------

const PEER = '00000000-0000-0000-0000-00000000000b'
const PEER_EMAIL = 'peer@example.test'
const HOUSEHOLD = '00000000-0000-0000-0000-0000000000f0'
/** Written into every personal row of the peer's; no tool output may ever contain it. */
const PEER_SECRET = 'PEER-PRIVATE'

function seedPeer() {
  psqlValue(`insert into auth.users (id, email) values (${lit(PEER)}, ${lit(PEER_EMAIL)}) on conflict do nothing`)
  psqlValue(`insert into public.households (id, name, created_by) values (${lit(HOUSEHOLD)}, 'Home', ${lit(OWNER)}) on conflict do nothing`)
  psqlValue(`insert into public.household_members (household_id, user_id, role)
             values (${lit(HOUSEHOLD)}, ${lit(OWNER)}, 'owner'), (${lit(HOUSEHOLD)}, ${lit(PEER)}, 'member') on conflict do nothing`)
}

/**
 * Store rows as the peer would: signed in (role authenticated, the peer's JWT
 * claims) through the real RPC and the real policies — not as the service
 * role, which would file them under the owner.
 */
function seedRowsAsPeer(items) {
  const claims = { sub: PEER, role: 'authenticated', email: PEER_EMAIL }
  const res = JSON.parse(psqlValue(`select public.sync_posts(${jsonLit(items)}::jsonb, '2099-01-01')::text`, 'authenticated', claims))
  if (res.rejected?.length) throw new Error(`mcp-smoke: the peer's seed rows were rejected: ${res.rejected.join(', ')}`)
}

// ---------------------------------------------------------------------------
// The PostgREST shim
//
// posts (GET) and the sync_posts / owner_user_id RPCs for the tools; the three
// agent-access tables, user_settings and their RPCs for the hosted endpoint
// and the OAuth server. Filters (eq, neq, gt, gte, lt, lte, is, in, or),
// order, select and Range paging are translated to SQL; `limit` and `offset`
// are deliberately not, so paging done any other way fails loudly here.
// Every response is capped at max_rows, as PostgREST's is — the cap the old
// server silently stopped at.
// ---------------------------------------------------------------------------

/** posts columns the shim will select on or filter by. Anything else is a 501, not an empty result. */
const POST_COLUMNS = new Set(['id', 'data', 'user_id', 'updated_at', 'synced_at', 'deleted', 'kind', 'status', 'title'])
/** The service-only tables and user_settings, served generically over their real columns. */
const REST_TABLES = new Set(['agent_tokens', 'oauth_clients', 'oauth_codes', 'user_settings'])
/** The RPCs the agent layer calls, beyond sync_posts and owner_user_id; 'void' ones answer 204. */
const RPCS = { agent_token_use: 'json', oauth_redeem_code: 'json', oauth_attach_grant: 'json', agent_token_rotate: 'json', oauth_client_use: 'json', oauth_prune: 'void' }

class Unsupported extends Error {}

/** Test switches: the two response shapes sync_posts has had, and a forced rejection. */
const shim = { syncShape: 'object', rejectAll: false }
/** Every request that reached the database, with the role it ran as. */
const audit = []

const tableColumns = new Map()
function columnsOf(table) {
  if (table === 'posts') return POST_COLUMNS
  if (!tableColumns.has(table)) {
    const cols = psqlJson(`select json_agg(column_name) from information_schema.columns where table_schema = 'public' and table_name = ${lit(table)}`)
    tableColumns.set(table, new Set(cols ?? []))
  }
  return tableColumns.get(table)
}

/** in.(a,b) or in.("a","b") */
function listOf(arg) {
  const m = /^\((.*)\)$/.exec(arg)
  if (!m) throw new Unsupported(`in-list "${arg}"`)
  return m[1].split(',').map(v => v.replace(/^"(.*)"$/, '$1'))
}

function condition(col, raw) {
  const dot = raw.indexOf('.')
  if (dot < 0) throw new Unsupported(`filter "${col}=${raw}" (no operator)`)
  const op = raw.slice(0, dot)
  const arg = raw.slice(dot + 1)
  const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }
  if (ops[op]) return `${col} ${ops[op]} ${lit(arg)}`
  if (op === 'is' && ['true', 'false', 'null'].includes(arg)) return `${col} is ${arg}`
  if (op === 'in') return `${col} in (${listOf(arg).map(lit).join(', ')})`
  throw new Unsupported(`operator "${op}" on "${col}"`)
}

/** WHERE over whitelisted columns of the table aliased t. `limit` and `offset` are columns nobody has. */
function whereOf(params, columns) {
  const conds = []
  for (const [key, raw] of params) {
    if (key === 'select' || key === 'order' || key === 'on_conflict') continue
    if (key === 'or') {
      const inner = /^\((.*)\)$/.exec(raw)?.[1]
      if (!inner) throw new Unsupported(`or=${raw}`)
      const parts = inner.split(',').map(part => {
        const d = part.indexOf('.')
        const col = part.slice(0, d)
        if (!columns.has(col)) throw new Unsupported(`or on column "${col}"`)
        return condition(`t.${col}`, part.slice(d + 1))
      })
      conds.push(`(${parts.join(' or ')})`)
      continue
    }
    if (!columns.has(key)) throw new Unsupported(`filter on column "${key}"`)
    conds.push(condition(`t.${key}`, raw))
  }
  return conds.length ? ` where ${conds.join(' and ')}` : ''
}

function orderOf(raw, columns) {
  if (!raw) return ''
  const parts = raw.split(',').map(part => {
    const [col, dir = 'asc'] = part.split('.')
    if (!columns.has(col) || !['asc', 'desc'].includes(dir)) throw new Unsupported(`order=${raw}`)
    return `t.${col} ${dir}`
  })
  return `order by ${parts.join(', ')}`
}

function selectOf(raw, columns, allowStar) {
  if (!raw) throw new Unsupported('no select (name the columns)')
  if (raw === '*') {
    if (!allowStar) throw new Unsupported('select=* (name the columns)')
    return 'row_to_json(t)'
  }
  const cols = raw.split(',').map(c => c.trim())
  for (const c of cols) if (!columns.has(c)) throw new Unsupported(`select of column "${c}"`)
  return `json_build_object(${cols.map(c => `${lit(c)}, t.${c}`).join(', ')})`
}

/** Range-Unit: items / Range: from-to, as PostgREST pages; no Range is the first max_rows. */
function rangeOf(headers) {
  if (!headers.range) return { offset: 0, limit: MAX_ROWS }
  if ((headers['range-unit'] ?? 'items') !== 'items') throw new Unsupported(`Range-Unit ${headers['range-unit']}`)
  const m = /^(\d+)-(\d+)$/.exec(headers.range)
  if (!m) throw new Unsupported(`Range ${headers.range}`)
  return { offset: Number(m[1]), limit: Math.min(Number(m[2]) - Number(m[1]) + 1, MAX_ROWS) }
}

function selectSql(table, params, headers) {
  const columns = columnsOf(table)
  const obj = selectOf(params.get('select'), columns, table !== 'posts')
  const where = whereOf(params, columns)
  const order = orderOf(params.get('order'), columns)
  const { offset, limit } = rangeOf(headers)
  return {
    offset,
    sql:
      `select coalesce(json_agg(s.j order by s.ord), '[]'::json)::text from (` +
      `select ${obj} as j, row_number() over (${order}) as ord from public.${table} t${where} ${order} limit ${limit} offset ${offset}) s`,
  }
}

function bodyColumns(table, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Unsupported(`a write to ${table} of anything but one object`)
  const columns = columnsOf(table)
  const keys = Object.keys(body)
  for (const k of keys) if (!columns.has(k)) throw new Unsupported(`a write to column "${k}" of ${table}`)
  return keys
}

/** Prefer: return=representation answers with the written rows (their `select` columns); otherwise nothing. */
function returning(table, params, headers, sql) {
  if (!/return=representation/.test(headers.prefer ?? '')) return { sql, rows: false }
  const obj = selectOf(params.get('select') ?? '*', columnsOf(table), true)
  return { sql: `with s as (${sql} returning ${obj} as j) select coalesce(json_agg(s.j), '[]'::json)::text from s`, rows: true }
}

/** POST: one object, typed by the table's own columns (json_populate_record, as PostgREST does); on_conflict upserts. */
function insertSql(table, params, headers, body) {
  const keys = bodyColumns(table, body)
  let conflict = ''
  const onConflict = params.get('on_conflict')
  if (onConflict) {
    if (!columnsOf(table).has(onConflict) || !/resolution=merge-duplicates/.test(headers.prefer ?? '')) throw new Unsupported(`on_conflict=${onConflict}`)
    const set = keys.filter(k => k !== onConflict)
    conflict = set.length ? ` on conflict (${onConflict}) do update set ${set.map(k => `${k} = excluded.${k}`).join(', ')}` : ` on conflict (${onConflict}) do nothing`
  }
  const insert = `insert into public.${table} as t (${keys.join(', ')}) select ${keys.map(k => `r.${k}`).join(', ')} from json_populate_record(null::public.${table}, ${jsonLit(body)}::json) r${conflict}`
  return returning(table, params, headers, insert)
}

/** PATCH: never without a filter. */
function updateSql(table, params, headers, body) {
  const keys = bodyColumns(table, body)
  const where = whereOf(params, columnsOf(table))
  if (!where) throw new Unsupported(`an update of ${table} with no filter`)
  const update = `update public.${table} as t set ${keys.map(k => `${k} = r.${k}`).join(', ')} from json_populate_record(null::public.${table}, ${jsonLit(body)}::json) r${where}`
  return returning(table, params, headers, update)
}

function rpcSql(fn, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Unsupported(`rpc ${fn} without a JSON object`)
  const args = Object.entries(body).map(([k, v]) => {
    if (!/^p_[a-z_]+$/.test(k)) throw new Unsupported(`rpc argument "${k}"`)
    return `${k} => ${v === null ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : lit(v)}`
  })
  const call = `public.${fn}(${args.join(', ')})`
  return RPCS[fn] === 'void' ? `select ${call}` : `select coalesce(to_json(${call}), 'null'::json)::text`
}

function rpcSyncPosts(body) {
  // Same contract as everywhere else here: a body shape this does not
  // implement is a 501 naming the path, never an empty result. Defaulting to []
  // would write nothing, answer { items: [], rejected: [] }, and have the server
  // report a lost write that never happened, pointing at the wrong thing.
  if (!Array.isArray(body?.incoming)) throw new Unsupported('sync_posts body without an "incoming" array')
  if (body.since !== undefined && body.since !== null && Number.isNaN(Date.parse(body.since))) throw new Unsupported(`sync_posts since=${body.since}`)
  return `select public.sync_posts(${jsonLit(body.incoming)}::jsonb, ${body.since ? `${lit(body.since)}::timestamptz` : 'null'})::text`
}

/** The role a request's keys map to, as PostgREST would: the service key, or a minted session's JWT. */
function whoIs(headers) {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1] ?? ''
  if (bearer === SERVICE_KEY && headers.apikey === SERVICE_KEY) return { role: 'service_role', claims: null }
  const m = /^user:([0-9a-f-]{36})$/.exec(bearer)
  if (m && headers.apikey === ANON_KEY) return { role: 'authenticated', claims: { sub: m[1], role: 'authenticated' } }
  return null
}

// ------------------------------------------------------------- the auth shim

const auth = { links: new Map(), mints: 0, verifyTypes: [], logouts: 0, rejectMagiclink: true }

function authRoute(method, path, headers, body, reply) {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1] ?? ''
  const serviceKeyed = headers.apikey === SERVICE_KEY && bearer === SERVICE_KEY
  const userById = id => psqlJson(`select json_build_object('id', id, 'email', email, 'banned_until', null) from auth.users where id = ${lit(id)}`)
  const admin = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(path)
  if (admin && method === 'GET') {
    if (!serviceKeyed) return reply(401, { msg: 'the admin API takes the service key' })
    audit.push({ method, path, role: 'service_role' })
    const user = userById(admin[1])
    return user ? reply(200, user) : reply(404, { msg: 'User not found' })
  }
  if (path === '/auth/v1/admin/generate_link' && method === 'POST') {
    if (!serviceKeyed) return reply(401, { msg: 'the admin API takes the service key' })
    audit.push({ method, path, role: 'service_role' })
    if (body?.type !== 'magiclink' || !body.email) return reply(400, { msg: `the shim only makes magic links, got ${JSON.stringify(body)}` })
    const user = psqlJson(`select json_build_object('id', id, 'email', email) from auth.users where email = ${lit(body.email)}`)
    if (!user) return reply(404, { msg: 'User not found' })
    const hashed = `smoke-link-${++auth.mints}-${randomBytes(6).toString('hex')}`
    auth.links.set(hashed, { userId: user.id, used: false })
    // the raw endpoint returns the link's fields at the top level (auth-js moves them into `properties`)
    return reply(200, { ...user, action_link: `https://auth.example/verify?token=${hashed}`, email_otp: '000000', hashed_token: hashed, redirect_to: '', verification_type: 'magiclink' })
  }
  if (path === '/auth/v1/verify' && method === 'POST') {
    if (headers.apikey !== ANON_KEY || bearer === SERVICE_KEY) return reply(401, { msg: 'verify is the browser’s call: the anon key, never the service key' })
    auth.verifyTypes.push(body?.type)
    // the hosted server has deprecated 'magiclink' as a verify type; this one refuses it outright
    if (auth.rejectMagiclink && body?.type === 'magiclink') return reply(403, { code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' })
    const link = auth.links.get(body?.token_hash)
    if (!link || link.used || body?.type !== 'email') return reply(403, { code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' })
    link.used = true
    const user = userById(link.userId)
    return reply(200, { access_token: `user:${link.userId}`, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'smoke-refresh', user })
  }
  if (path === '/auth/v1/logout' && method === 'POST') {
    auth.logouts++
    return reply(204)
  }
  if (path === '/auth/v1/user' && method === 'GET') {
    const m = /^user:([0-9a-f-]{36})$/.exec(bearer)
    const user = m && headers.apikey === ANON_KEY ? userById(m[1]) : null
    return user ? reply(200, { id: user.id, email: user.email }) : reply(401, { msg: 'invalid JWT' })
  }
  return null
}

// ---------------------------------------------------------------- dispatcher

function startShim() {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://shim')
      const headers = req.headers
      const reply = (code, payload, extra = {}) => {
        if (payload === undefined) {
          res.writeHead(code, extra)
          return res.end()
        }
        res.writeHead(code, { 'content-type': 'application/json', ...extra })
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
      }
      const unimplemented = why => reply(501, { message: `mcp-smoke shim does not implement ${req.method} ${url.pathname}${url.search} — ${why}` })
      try {
        let body = null
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (url.pathname.startsWith('/auth/v1/')) {
          if (authRoute(req.method, url.pathname, headers, body, reply) === null) return unimplemented('unknown auth route')
          return
        }

        // build the SQL first: an unimplemented request is a 501 whoever sends it
        let plan = null
        const params = url.searchParams
        const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1]
        const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1]
        if (req.method === 'GET' && table === 'posts') {
          const s = selectSql('posts', params, headers)
          plan = { sql: s.sql, offset: s.offset, kind: 'rows' }
        } else if (req.method === 'POST' && rpc === 'sync_posts') {
          plan = { sql: shim.rejectAll ? null : rpcSyncPosts(body), kind: 'sync' }
        } else if (req.method === 'POST' && rpc === 'owner_user_id') {
          plan = { sql: 'select to_json(public.owner_user_id())', kind: 'value' }
        } else if (req.method === 'POST' && rpc && RPCS[rpc]) {
          plan = { sql: rpcSql(rpc, body), kind: RPCS[rpc] === 'void' ? 'void' : 'value' }
        } else if (REST_TABLES.has(table) && req.method === 'GET') {
          const s = selectSql(table, params, headers)
          plan = { sql: s.sql, offset: s.offset, kind: 'rows' }
        } else if (REST_TABLES.has(table) && req.method === 'POST') {
          const r = insertSql(table, params, headers, body)
          plan = { sql: r.sql, kind: r.rows ? 'created-rows' : 'created' }
        } else if (REST_TABLES.has(table) && req.method === 'PATCH') {
          const r = updateSql(table, params, headers, body)
          plan = { sql: r.sql, kind: r.rows ? 'rows' : 'none' }
        } else {
          return unimplemented('unknown route')
        }

        const who = whoIs(headers)
        if (!who) return reply(401, { code: 'PGRST301', message: 'the shim knows the service key and minted sessions (user:<uuid>) only' })
        audit.push({ method: req.method, path: url.pathname, role: who.role, range: headers.range ?? null })

        if (plan.kind === 'sync' && shim.rejectAll) {
          // the server must surface this, not report success
          return reply(200, { items: [], rejected: body.incoming.map(i => i?.id).filter(Boolean) })
        }
        let text
        try {
          text = psqlValue(plan.sql, who.role, who.claims)
        } catch (e) {
          const message = String(e?.message ?? e)
          if (/permission denied/.test(message)) return reply(403, { code: '42501', message })
          if (/violates/.test(message)) return reply(409, { code: '23505', message })
          return reply(400, { message })
        }
        if (plan.kind === 'sync') {
          if (shim.syncShape === 'legacy') return reply(200, JSON.stringify(JSON.parse(text).items ?? []))
          return reply(200, text)
        }
        if (plan.kind === 'rows') {
          const n = JSON.parse(text).length
          return reply(200, text, n ? { 'content-range': `${plan.offset}-${plan.offset + n - 1}/*` } : {})
        }
        if (plan.kind === 'created-rows') return reply(201, text)
        if (plan.kind === 'created') return reply(201)
        if (plan.kind === 'void' || plan.kind === 'none') return reply(204)
        return reply(200, text || 'null')
      } catch (e) {
        if (e instanceof Unsupported) return unimplemented(e.message)
        return reply(500, { message: String(e?.message ?? e) })
      }
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

// ---------------------------------------------------------------------------
// The site: the real Netlify handlers for /api/mcp and the OAuth server
// ---------------------------------------------------------------------------

async function startSite(shimUrl) {
  process.env.SUPABASE_URL = shimUrl
  process.env.SUPABASE_ANON_KEY = ANON_KEY
  process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY
  delete process.env.CONTEXT
  delete process.env.DEPLOY_PRIME_URL
  delete process.env.OAUTH_REDIRECT_ALLOWLIST
  delete process.env.MCP_RATE_LIMIT_PER_MIN
  const { mcpEndpoint } = await import(pathToFileURL(join(ROOT, 'netlify/functions/lib/mcphttp.mjs')).href)
  const { oauthHandler, routeOf } = await import(pathToFileURL(join(ROOT, 'netlify/functions/lib/oauthserver.mjs')).href)
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const url = new URL(req.url, process.env.URL)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
      const handler = url.pathname === '/api/mcp' ? mcpEndpoint : routeOf(url.pathname) ? oauthHandler : null
      const response = handler ? await handler(request, {}) : new Response('Not found', { status: 404 })
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`site error: ${e?.stack ?? e}`)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.URL = `http://127.0.0.1:${server.address().port}`
  return { server, url: process.env.URL }
}

// ---------------------------------------------------------------------------
// The MCP server, over stdio
// ---------------------------------------------------------------------------

function startMcp(env) {
  const child = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], env })
  const stderr = []
  child.stderr.on('data', d => stderr.push(String(d)))
  const waiting = new Map()
  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        console.error(`mcp-smoke: server wrote a non-JSON line: ${line.slice(0, 200)}`)
        continue
      }
      const resolve = waiting.get(msg.id)
      if (resolve) {
        waiting.delete(msg.id)
        resolve(msg)
      }
    }
  })
  let nextId = 1
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`mcp-smoke: no answer to ${method} in 30s. stderr:\n${stderr.join('')}`))
      }, 30_000)
      waiting.set(id, msg => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const notify = method => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  return { child, rpc, notify, stderr }
}

/** The environment a child server gets: this one's, minus anything that would pick its mode for it. */
function childEnv(extra) {
  const env = { ...process.env }
  for (const k of ['DRAFTER_AGENT_TOKEN', 'DRAFTER_MCP_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY']) delete env[k]
  return { ...env, ...extra }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let step = 0
function ok(cond, what) {
  if (!cond) throw new Error(`FAIL: ${what}`)
  console.log(`  ok ${++step}: ${what}`)
}
const eq = (actual, expected, what) => ok(actual === expected, `${what} (got ${JSON.stringify(actual)})`)

/** The stored row for an id, straight from Postgres — never through the server. */
const row = id => psqlJson(`select coalesce((select json_build_object('data', data, 'user_id', user_id, 'deleted', deleted, 'kind', kind) from public.posts where id = ${lit(id)}), 'null'::json)::text`)

/** Call a tool over a stdio server and parse its JSON payload; throws when the server reported an error. */
async function callOver(mcp, name, args = {}) {
  const res = await mcp.rpc('tools/call', { name, arguments: args })
  const text = res.result?.content?.[0]?.text ?? ''
  if (res.result?.isError) throw new Error(`tool ${name} failed: ${text}`)
  if (res.error) throw new Error(`tool ${name}: ${res.error.message}`)
  return JSON.parse(text)
}

async function main() {
  console.log('mcp-smoke: starting a throwaway Postgres…')
  startDatabase()
  seedOwner()
  const { server, url } = await startShim()
  const legacyServer = startMcp(childEnv({ SUPABASE_URL: url, SUPABASE_SERVICE_KEY: SERVICE_KEY }))
  const { child, rpc } = legacyServer
  const call = (name, args) => callOver(legacyServer, name, args)
  /** The same, for calls that must fail: returns the error text. */
  async function callFails(name, args = {}) {
    const res = await rpc('tools/call', { name, arguments: args })
    const text = res.result?.content?.[0]?.text ?? ''
    if (!res.result?.isError) throw new Error(`FAIL: ${name} was supposed to fail, returned ${text.slice(0, 200)}`)
    return text
  }
  let site = null
  let proxy = null

  try {
    console.log('mcp-smoke: the deprecated local mode (service key, owner\'s view)…')
    // ------------------------------------------------------------- handshake
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1' } })
    eq(init.result?.serverInfo?.name, 'drafter', 'initialize names the drafter server')
    eq(init.result?.protocolVersion, '2025-06-18', 'initialize echoes the requested protocol version')

    const list = await rpc('tools/list')
    const names = (list.result?.tools ?? []).map(t => t.name)
    eq(names.length, 23, 'tools/list offers 23 tools')
    const expected = [
      'list_projects', 'create_project', 'update_project', 'list_tasks', 'get_task', 'create_task', 'update_task',
      'complete_task', 'add_comment', 'delete_task', 'list_people', 'list_places', 'create_place', 'log_visit',
      'list_recipes', 'get_week_meals', 'plan_meal', 'get_grocery_list', 'add_grocery_item', 'set_grocery_state',
      'list_journal', 'add_journal_entry', 'get_overview',
    ]
    ok(expected.every(n => names.includes(n)), 'every expected tool is present')
    ok((list.result?.tools ?? []).every(t => t.description && t.inputSchema?.type === 'object'), 'every tool has a description and an object schema')
    ok(/DEPRECATED — service-key mode/.test(legacyServer.stderr.join('')), 'the service-key mode says it is deprecated on stderr')

    // ------------------------------------------------------------- projects
    const project = (await call('create_project', { name: 'Kitchen refit', description: 'New worktop', targetAt: '2026-12-01T00:00:00.000Z' })).created
    const projectRow = row(project.id)
    ok(projectRow, 'create_project stored a row')
    eq(projectRow.kind, 'project', 'the stored project has kind project')
    eq(projectRow.data.name, 'Kitchen refit', 'the stored project kept its name')
    eq(projectRow.data.status, 'active', 'a new project is active')
    eq(projectRow.user_id, OWNER, 'the project belongs to the owner (service key → owner_user_id)')

    // Rows with no create tool (a person, a recipe), seeded through the real RPC. This runs
    // after the first tool write on purpose: a broken sync_posts should surface as a failed
    // create_project — the diagnostic the owner needs — not as a confusing seed error.
    const seedStamp = new Date(Date.now() - 60_000).toISOString()
    seedRows([
      { kind: 'person', id: 'mum', name: 'Mum', color: '#f472b6', group: 'family', createdAt: seedStamp, updatedAt: seedStamp },
      {
        kind: 'recipe', id: 'pasta', name: 'Pasta', color: '#eab308', servings: 2, tags: ['quick'],
        ingredients: [{ name: 'Spaghetti', qty: 500, unit: 'g' }, { name: 'Tomatoes', qty: 4 }],
        steps: ['Boil', 'Toss'], createdAt: seedStamp, updatedAt: seedStamp,
      },
    ])

    // --------------------------------------------------------------- places
    const place = (await call('create_place', { name: 'Nopi', category: 'restaurant', cadenceDays: 30, notes: 'Book ahead' })).created
    const placeRow = row(place.id)
    eq(placeRow?.kind, 'place', 'create_place stored a place row')
    eq(placeRow.data.cadenceDays, 30, 'the place kept its cadence')
    eq(placeRow.user_id, OWNER, 'the place belongs to the owner')

    // ---------------------------------------------------------------- tasks
    const task = (await call('create_task', {
      title: 'Dinner with Mum',
      projectId: project.id,
      peopleIds: ['mum'],
      placeName: 'nopi',
      dueAt: '2026-09-20T18:00:00.000Z',
      priority: 'high',
    })).created
    const taskRow = row(task.id)
    eq(taskRow?.kind, 'task', 'create_task stored a task row')
    ok(taskRow.data.peopleIds?.includes('mum'), 'the task carries the person id')
    eq(taskRow.data.placeId, place.id, 'placeName resolved to the saved place id')
    eq(taskRow.data.projectId, project.id, 'the task landed in the project')
    eq(taskRow.user_id, OWNER, 'the task belongs to the owner')

    const updated = (await call('update_task', { id: task.id, status: 'doing', addChecklist: ['Book a table', 'Buy flowers'] })).updated
    const updatedRow = row(task.id)
    eq(updatedRow.data.status, 'doing', 'update_task moved the stored status')
    eq(updatedRow.data.checklist?.length, 2, 'update_task appended both checklist steps')
    ok(updatedRow.data.updatedAt > taskRow.data.updatedAt, 'update_task bumped updatedAt')
    eq(updated.status, 'doing', 'update_task reported the new status')

    // ------------------------------------------------- recurrence on completion
    const repeating = (await call('create_task', { title: 'Water the plants', recurrence: 'weekly', dueAt: '2026-09-10T09:00:00.000Z' })).created
    const done = await call('complete_task', { id: repeating.id, comment: 'Watered' })
    ok(done.nextOccurrence?.id && done.nextOccurrence.id !== repeating.id, 'complete_task spawned a next occurrence')
    const closedRow = row(repeating.id)
    eq(closedRow.data.status, 'done', 'the completed task is stored done')
    ok(closedRow.data.completedAt, 'the completed task has a completedAt')
    eq(closedRow.data.recurrence, undefined, 'the recurrence moved off the completed copy')
    eq(closedRow.data.comments?.length, 1, 'the closing comment was stored')
    const spawnRow = row(done.nextOccurrence.id)
    eq(spawnRow?.data.status, 'todo', 'the next occurrence is stored as todo')
    eq(spawnRow.data.recurrence?.freq, 'weekly', 'the next occurrence carries the rhythm forward')
    eq(spawnRow.data.spawnedFrom, repeating.id, 'the next occurrence points back at its parent')
    eq(spawnRow.user_id, OWNER, 'the spawned occurrence belongs to the owner')

    // ------------------------------------------------------------- log_visit
    const visit = (await call('log_visit', { personId: 'mum', placeName: 'Nopi', note: 'Sunday lunch' })).logged
    const visitRow = row(visit.id)
    eq(visitRow?.data.status, 'done', 'log_visit stores a completed task')
    eq(visitRow.data.placeId, place.id, 'the visit is attached to the place')
    ok(visitRow.data.peopleIds?.includes('mum'), 'the visit is attached to the person')
    ok((visitRow.data.tags ?? []).includes('visit'), 'the visit is tagged visit')
    eq(visitRow.user_id, OWNER, 'the visit belongs to the owner')
    const places = await call('list_places', {})
    const nopi = places.places.find(p => p.id === place.id)
    eq(nopi?.outingsAllTime, 1, 'list_places counts the outing it just logged')

    // --------------------------------------------------------------- kitchen
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const planned = await call('plan_meal', { date: today, recipeName: 'Pasta', notes: 'Double it' })
    const mealRow = row(`meal~${today}~dinner`)
    eq(mealRow?.kind, 'meal', 'plan_meal stored the meal')
    eq(mealRow.data.recipeId, 'pasta', 'the meal points at the recipe')
    eq(mealRow.user_id, OWNER, 'the meal belongs to the owner')
    const groceryRow = row(`grocery~${planned.weekKey}`)
    eq(groceryRow?.kind, 'grocery', 'plan_meal stored the grocery list in the same round')
    eq(groceryRow.user_id, OWNER, 'the grocery list belongs to the owner')
    eq(groceryRow.data.items?.length, 2, "the list holds both of the recipe's ingredients")
    ok(groceryRow.data.items.some(i => i.name === 'Spaghetti' && i.qty === 500 && i.unit === 'g'), 'a grocery line kept its quantity and unit')

    // ---- eating out: the other way to answer "what are we eating"
    // A bought meal must add nothing to the shop, and once its day has passed
    // it must count as an outing at the place — that is what makes "how often
    // do we eat there" and "been a while" agree instead of drifting apart.
    const yesterday = (() => {
      const y = new Date()
      y.setDate(y.getDate() - 1)
      return `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
    })()
    const groceriesBefore = (row(`grocery~${planned.weekKey}`).data.items ?? []).length
    const outMeal = await call('plan_meal', { date: yesterday, out: true, placeName: 'Nopi' })
    eq(outMeal.planned.out, true, 'plan_meal recorded a bought meal')
    eq(outMeal.planned.placeId, place.id, 'the bought meal points at the place')
    const outRow = row(`meal~${yesterday}~dinner`)
    eq(outRow?.kind, 'meal', 'the bought meal is stored as a meal row')
    eq(outRow.data.out, true, 'the stored meal is marked as eaten out')
    eq(outRow.data.recipeId, undefined, 'a bought meal carries no recipe')
    eq((row(`grocery~${planned.weekKey}`).data.items ?? []).length, groceriesBefore, 'a bought meal adds nothing to the grocery list')
    const afterEating = await call('list_places', {})
    const nopiAfter = afterEating.places.find(p => p.id === place.id)
    eq(nopiAfter?.mealsHereAllTime, 1, 'list_places counts the meal eaten there')
    eq(nopiAfter?.outingsAllTime, 2, 'the meal joins the logged visit as an outing')
    // a meal planned for NEXT week is a plan, not a visit
    const future = (() => {
      const f = new Date()
      f.setDate(f.getDate() + 9)
      return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`
    })()
    await call('plan_meal', { date: future, out: true, placeName: 'Nopi' })
    const afterPlanning = await call('list_places', {})
    const nopiLater = afterPlanning.places.find(p => p.id === place.id)
    eq(nopiLater?.outingsAllTime, 2, 'a meal planned for the future is not counted as an outing yet')
    eq(nopiLater?.mealsHereAllTime, 1, 'nor as a meal eaten there yet')
    let refusedBoth = null
    try {
      await call('plan_meal', { date: today, out: true, recipeName: 'Pasta' })
    } catch (e) {
      refusedBoth = String(e.message ?? e)
    }
    ok(refusedBoth && /cooked|bought/i.test(refusedBoth), 'a meal cannot be both cooked and bought')

    await call('add_grocery_item', { name: 'Milk', qty: 2, unit: 'l', date: today })
    const withMilk = row(`grocery~${planned.weekKey}`).data.items ?? []
    const milk = withMilk.find(i => i.name === 'Milk')
    ok(milk, 'add_grocery_item stored a hand-added line')
    eq(milk.manual, true, 'the hand-added line is marked manual')
    eq(milk.state, 'need', 'the hand-added line starts as need')

    await call('set_grocery_state', { name: 'Milk', state: 'done', date: today })
    eq(row(`grocery~${planned.weekKey}`).data.items.find(i => i.name === 'Milk')?.state, 'done', 'set_grocery_state ticked the stored line')

    const week = await call('get_week_meals', { date: today })
    ok(week.meals.some(m => m.id === `meal~${today}~dinner`), 'get_week_meals sees the meal it planned')
    ok(week.grocery?.items?.length >= 3, 'get_week_meals returns the week grocery list')

    // --------------------------------------------------------------- journal
    const first = await call('add_journal_entry', { text: 'Fixed the tap.', mood: 4, peopleNames: ['Mum'] })
    eq(first.created, true, 'add_journal_entry created today’s entry')
    const journalId = first.entry.id
    const firstRow = row(journalId)
    eq(firstRow?.kind, 'journal', 'the journal entry is stored as a journal row')
    eq(firstRow.data.body, 'Fixed the tap.', 'the first line is stored')
    eq(firstRow.user_id, OWNER, 'the journal entry belongs to the owner')
    ok(firstRow.data.peopleIds?.includes('mum'), 'peopleNames resolved to the person id')

    const second = await call('add_journal_entry', { text: 'Then a long walk.' })
    eq(second.created, false, 'the second line appended to the same day')
    eq(second.entry.id, journalId, 'appending did not create a second row for the day')
    const appended = row(journalId).data
    eq(appended.body, 'Fixed the tap.\nThen a long walk.', 'the append kept the first line')
    eq(appended.mood, 4, 'the append kept the mood')
    eq(psqlJson(`select to_json(count(*)) from public.posts where kind = 'journal'`), 1, 'still exactly one journal row')

    const journal = await call('list_journal', { days: 7 })
    eq(journal.count, 1, 'list_journal returns the day')
    eq(journal.entries[0].body, 'Fixed the tap.\nThen a long walk.', 'list_journal reads back both lines')
    ok(journal.entries[0].people.includes('Mum'), 'list_journal names the tagged person')
    ok(journal.streak >= 1, 'list_journal reports a streak')

    // -------------------------------------------------------------- overview
    const overview = await call('get_overview', {})
    eq(overview.journal.writtenToday, true, 'get_overview knows today has an entry')
    ok(overview.projects.some(p => p.id === project.id), 'get_overview lists the project')
    ok(overview.counts.doing >= 1, 'get_overview counts the doing task')
    ok(overview.completedLast7Days >= 2, 'get_overview counts the completed task and the visit')

    // ------------------------------- a household peer's personal rows stay theirs
    // The service key bypasses every policy, so the server is all that stands
    // between an agent and a peer's diary. The peer writes one row of every
    // personal kind (each carrying PEER_SECRET) and one shared chore; then every
    // read tool runs, and every id-based tool is aimed at the personal ids.
    seedPeer()
    const peerStamp = new Date(Date.now() - 30_000).toISOString()
    const peerRow = (kind, id, fields) => ({ kind, id, createdAt: peerStamp, updatedAt: peerStamp, ...fields })
    const peerPersonal = [
      peerRow('habit', 'peer-1', { name: `${PEER_SECRET} habit`, done: [today] }),
      peerRow('routine', 'peer-2', { name: `${PEER_SECRET} routine`, when: 'morning', steps: [{ id: 's1', text: PEER_SECRET }], ticks: [] }),
      peerRow('review', 'peer-3', { period: 'week', key: planned.weekKey, top: [`${PEER_SECRET} review`] }),
      peerRow('calendar', 'peer-4', { name: `${PEER_SECRET} calendar`, url: 'https://example.test/peer.ics', color: '#888', enabled: true }),
      peerRow('journal', `journal~${today}~peer`, { date: today, body: `${PEER_SECRET} journal`, mood: 2 }),
    ]
    seedRowsAsPeer([...peerPersonal, peerRow('task', 'peer-chore', { title: 'Peer chore: bins', description: '', status: 'todo', priority: 'normal', tags: [] })])
    ok(peerPersonal.every(p => row(p.id)?.user_id === PEER), "the peer's habit, routine, review, calendar and journal are stored under the peer")

    const peerTexts = []
    /** Any tool call, keeping what came back: the peer's marker must never be in it. */
    async function probe(name, args) {
      const res = await rpc('tools/call', { name, arguments: args })
      const text = res.result?.content?.[0]?.text ?? res.error?.message ?? ''
      peerTexts.push(`${name}: ${text}`)
      return { text, isError: !!res.result?.isError || !!res.error }
    }
    const reads = [
      ['list_projects', { includeArchived: true }], ['list_tasks', { limit: 200 }], ['list_people', {}], ['list_places', {}],
      ['list_recipes', {}], ['get_week_meals', { date: today }], ['get_grocery_list', { date: today }],
      ['list_journal', { days: 366 }], ['list_journal', { search: 'peer' }], ['get_overview', {}],
    ]
    const failedReads = []
    for (const [name, args] of reads) if ((await probe(name, args)).isError) failedReads.push(name)
    eq(failedReads.join(', '), '', 'every read tool answers with a peer in the household')
    eq(JSON.parse((await probe('list_tasks', { search: 'Peer chore' })).text).count, 1, "the peer's shared chore is still visible: household sharing is kept")
    const lastWeek = JSON.parse((await probe('list_journal', { days: 7 })).text)
    ok(lastWeek.entries.every(e => e.id !== `journal~${today}~peer`), "list_journal leaves out the peer's entry for today")

    for (const p of peerPersonal) {
      const answered = []
      for (const [name, args] of [
        ['get_task', { id: p.id }], ['update_task', { id: p.id, title: 'mine now' }], ['complete_task', { id: p.id }],
        ['add_comment', { id: p.id, body: 'hello' }], ['delete_task', { id: p.id }], ['update_project', { id: p.id, name: 'mine now' }],
      ]) {
        const r = await probe(name, args)
        if (!r.isError || !/^Error: No (task|project) with id "/.test(r.text)) answered.push(`${name}: ${r.text.slice(0, 120)}`)
      }
      eq(answered.join(' | '), '', `every id-based tool treats the peer's ${p.kind} as missing`)
      eq(row(p.id).data.updatedAt, peerStamp, `the peer's ${p.kind} is untouched`)
    }

    const bath = JSON.parse((await probe('add_journal_entry', { text: 'And a bath.' })).text)
    eq(bath.entry?.id, journalId, "add_journal_entry appends to the owner's day, never the peer's")
    eq(row(`journal~${today}~peer`).data.body, `${PEER_SECRET} journal`, "the peer's journal body is unchanged")
    const leaked = peerTexts.filter(t => t.includes(PEER_SECRET)).map(t => t.split(':')[0])
    eq(leaked.join(', '), '', `no tool output carried the peer's personal rows (${peerTexts.length} calls checked)`)

    // ------------------------------------------- negative: legacy RPC shape
    shim.syncShape = 'legacy'
    const legacy = (await call('create_task', { title: 'Written against the old RPC shape' })).created
    eq(row(legacy.id)?.data.title, 'Written against the old RPC shape', 'a bare-array sync_posts response still stores the row')
    shim.syncShape = 'object'

    // ------------------------------------------- negative: rejected id is loud
    shim.rejectAll = true
    const refused = await callFails('create_task', { title: 'Should be refused' })
    ok(/refused to store/.test(refused), 'a rejected id makes the server throw rather than report success')
    shim.rejectAll = false
    eq(psqlJson(`select to_json(count(*)) from public.posts where data ->> 'title' = 'Should be refused'`), 0, 'nothing was stored for the refused write')

    // --------------------------------- negative: the shim never answers blind
    const bad = await fetch(`${url}/rest/v1/posts?select=data&title=like.*x*`)
    eq(bad.status, 501, 'an unimplemented filter is a loud 501, not an empty array')
    ok((await bad.text()).includes('/rest/v1/posts'), 'the 501 names the path it could not serve')
    const paged = await fetch(`${url}/rest/v1/posts?select=data&limit=1`)
    eq(paged.status, 501, 'an unimplemented limit is a loud 501, not a full table')
    const noRoute = await fetch(`${url}/rest/v1/rpc/not_a_function`, { method: 'POST', body: '{}' })
    eq(noRoute.status, 501, 'an unimplemented route is a loud 501')
    const noKey = await fetch(`${url}/rest/v1/posts?select=data`)
    eq(noKey.status, 401, 'a request with neither the service key nor a session is refused')

    // =====================================================================
    // The hosted endpoint: /api/mcp and the OAuth server, as the token's user
    // =====================================================================
    console.log('mcp-smoke: the hosted /api/mcp, the stdio proxy and the OAuth server (as the token\'s user)…')
    // the user's zone decides "today" on the endpoint; the machine's is what the checks above used
    psqlValue(`insert into public.user_settings (user_id, timezone) values (${lit(OWNER)}, ${lit(MACHINE_TZ)}), (${lit(PEER)}, ${lit(MACHINE_TZ)})
               on conflict (user_id) do update set timezone = excluded.timezone`)
    site = await startSite(url)
    const MCP_URL = `${site.url}/api/mcp`
    audit.length = 0
    const agentauth = await import(pathToFileURL(join(ROOT, 'netlify/functions/lib/agentauth.mjs')).href)

    // ---------------------------------------------------------- manual tokens
    const ownerTok = await agentauth.createManualToken(OWNER, { name: 'Smoke laptop', scopes: ['read', 'write', 'journal'] })
    ok(/^drft_[A-Za-z0-9_-]{43}$/.test(ownerTok.token), 'createManualToken returned a drft_ token')
    const storedTok = psqlJson(`select json_build_object('hash', access_hash, 'prefix', token_prefix, 'kind', kind, 'user', user_id) from public.agent_tokens where id = ${lit(ownerTok.connection.id)}`)
    eq(storedTok?.hash, sha256(ownerTok.token), "the database holds the token's SHA-256")
    eq(psqlJson(`select to_json(count(*)) from public.agent_tokens where access_hash = ${lit(ownerTok.token)} or token_prefix = ${lit(ownerTok.token)}`), 0, 'and not the token itself')
    eq(storedTok.prefix, ownerTok.token.slice(0, 9), 'only a nine-character prefix is kept for the UI')
    const peerTok = await agentauth.createManualToken(PEER, { name: 'Peer laptop', scopes: ['read', 'write'] })
    const readOnlyTok = await agentauth.createManualToken(OWNER, { name: 'Read only', scopes: ['read'] })
    eq((await agentauth.listConnections(OWNER)).map(c => c.name).sort().join(', '), 'Read only, Smoke laptop', "listConnections shows the owner's own tokens and not the peer's")

    // ------------------------------------------------------ the transport, direct
    let nextHttpId = 1
    const postMcp = (token, body, headers = {}) =>
      fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) })
    const ping = () => ({ jsonrpc: '2.0', id: nextHttpId++, method: 'ping' })
    async function callHttp(token, name, args = {}) {
      const res = await postMcp(token, { jsonrpc: '2.0', id: nextHttpId++, method: 'tools/call', params: { name, arguments: args } })
      const body = await res.json()
      return { status: res.status, isError: !!body.result?.isError, text: body.result?.content?.[0]?.text ?? body.error?.message ?? '' }
    }
    const listHttp = async token => (await (await postMcp(token, { jsonrpc: '2.0', id: nextHttpId++, method: 'tools/list' })).json()).result?.tools?.map(t => t.name) ?? []

    const noBearer = await postMcp(null, ping())
    eq(noBearer.status, 401, '/api/mcp without a token is 401')
    eq(noBearer.headers.get('www-authenticate'), `Bearer realm="drafter", resource_metadata="${site.url}/.well-known/oauth-protected-resource/api/mcp"`, 'and says where to find the OAuth server')
    const unknown = await postMcp(`drft_${'z'.repeat(43)}`, ping())
    eq(unknown.status, 401, 'an unknown token is 401')
    ok(unknown.headers.get('www-authenticate')?.endsWith('error="invalid_token"'), 'with error="invalid_token"')
    const notification = await postMcp(ownerTok.token, { jsonrpc: '2.0', method: 'notifications/initialized' })
    eq(notification.status, 202, 'a notification is 202')
    eq(await notification.text(), '', 'with an empty body')
    const prm = await (await fetch(`${site.url}/.well-known/oauth-protected-resource/api/mcp`)).json()
    eq(prm.resource, MCP_URL, 'the protected-resource metadata names /api/mcp')
    eq(prm.authorization_servers?.[0], site.url, 'and this site as its authorization server')
    eq(psqlJson(`select to_json(last_used_at is not null) from public.agent_tokens where id = ${lit(ownerTok.connection.id)}`), true, 'a used token has last_used_at stamped')

    // ------------------------------------------------ the stdio proxy, as the owner
    proxy = startMcp(childEnv({ DRAFTER_AGENT_TOKEN: ownerTok.token, DRAFTER_MCP_URL: MCP_URL }))
    const pinit = await proxy.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-smoke-proxy', version: '1' } })
    eq(pinit.result?.protocolVersion, '2025-06-18', 'through the proxy, initialize negotiates 2025-06-18')
    ok(pinit.result?.instructions?.includes(MACHINE_TZ), "initialize's instructions name the user's zone from user_settings")
    proxy.notify('notifications/initialized')
    const plist = await proxy.rpc('tools/list')
    eq(plist.result?.tools?.length, 23, 'a read, write and journal token sees all 23 tools')
    ok(plist.result.tools.every(t => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'), 'every tool carries annotations')
    ok(!/DEPRECATED/.test(proxy.stderr.join('')), 'the proxy mode prints no deprecation warning')
    const viaProxy = (await callOver(proxy, 'create_task', { title: 'Written through the proxy' })).created
    eq(row(viaProxy.id)?.user_id, OWNER, "a task created through the proxy is the token's user's")
    const ownJournal = await callOver(proxy, 'list_journal', { days: 7 })
    ok(ownJournal.entries.some(e => e.id === journalId), "the owner's journal is there on the endpoint")
    ok(ownJournal.entries.every(e => e.id !== `journal~${today}~peer`), "and the peer's is not: the database's policy keeps it")
    const proxied = await callOver(proxy, 'add_journal_entry', { text: 'Through the proxy.' })
    eq(proxied.entry.id, journalId, "add_journal_entry appends to the owner's own day")
    ok(row(journalId).data.body.endsWith('Through the proxy.'), 'and the line is stored')
    const hostedOverview = await callOver(proxy, 'get_overview', {})
    eq(hostedOverview.timeZone, MACHINE_TZ, "get_overview reports the user's zone")
    eq(hostedOverview.today, today, "and today is the user's today")

    // ------------------------------------------------------- the peer's token
    const peerTools = await listHttp(peerTok.token)
    ok(peerTools.includes('create_task') && !peerTools.includes('list_journal'), 'a token without journal access lists no journal tools')
    const peerMade = JSON.parse((await callHttp(peerTok.token, 'create_task', { title: 'Peer via the endpoint' })).text).created
    eq(row(peerMade.id)?.user_id, PEER, "a task created with the peer's token belongs to the peer, not the owner")
    eq(JSON.parse((await callHttp(peerTok.token, 'list_tasks', { search: 'Dinner with Mum' })).text).count, 1, "the peer sees the owner's shared task: household sharing holds")
    const peerJournal = await callHttp(peerTok.token, 'list_journal', {})
    ok(peerJournal.isError && /Settings → Assistants/.test(peerJournal.text), 'the journal is refused to a token without journal access')
    const peerProbe = await callHttp(peerTok.token, 'get_task', { id: journalId })
    ok(peerProbe.isError && /^Error: No task with id "/.test(peerProbe.text), "the owner's journal reads as missing to the peer")
    const peerHabits = await callHttp(peerTok.token, 'get_task', { id: 'peer-1' })
    ok(peerHabits.isError && /is a habit, not a task/.test(peerHabits.text), "while the peer's own habit is theirs to see")

    // writing onto the peer's journal as the owner, below the tools: the database refuses it
    const { createRestData } = await import(pathToFileURL(join(ROOT, 'mcp/data.mjs')).href)
    const asOwner = createRestData({ baseUrl: url, mode: 'user', userId: OWNER, auth: async () => ({ apikey: ANON_KEY, bearer: `user:${OWNER}` }) })
    let peerWrite = null
    try {
      await asOwner.syncWrite([{ kind: 'journal', id: `journal~${today}~peer`, date: today, body: 'mine now', createdAt: peerStamp, updatedAt: new Date().toISOString() }])
    } catch (e) {
      peerWrite = String(e.message ?? e)
    }
    ok(peerWrite && /refused to store/.test(peerWrite), "a write onto the peer's journal with the owner's session is rejected")
    eq(row(`journal~${today}~peer`).data.body, `${PEER_SECRET} journal`, "the peer's journal is unchanged")

    // ------------------------------------------------------- a read-only token
    const readOnlyTools = await listHttp(readOnlyTok.token)
    ok(readOnlyTools.includes('list_tasks') && !readOnlyTools.includes('create_task'), 'a read-only token lists no write tools')
    const readOnlyWrite = await callHttp(readOnlyTok.token, 'create_task', { title: 'Read-only should not write' })
    ok(readOnlyWrite.isError && /read-only/.test(readOnlyWrite.text), 'and is refused one it calls anyway')
    eq(psqlJson(`select to_json(count(*)) from public.posts where data ->> 'title' = 'Read-only should not write'`), 0, 'nothing was stored')

    // ------------------------------------------------- paging past max_rows
    const bulkStamp = new Date(Date.now() - 20_000).toISOString()
    seedRows(Array.from({ length: 1001 }, (_, i) => ({ kind: 'task', id: `bulk-${i}`, title: `Bulk ${i}`, description: '', status: 'todo', priority: 'low', tags: ['bulk'], createdAt: bulkStamp, updatedAt: bulkStamp })))
    const probeMark = audit.length
    const unpaged = await fetch(`${url}/rest/v1/posts?select=data&deleted=is.false`, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } })
    eq((await unpaged.json()).length, MAX_ROWS, 'the shim, like PostgREST, answers at most max_rows rows at once')
    audit.splice(probeMark, 1) // that read was this test's, with the service key on purpose — not the endpoint's
    const bulk = await callOver(proxy, 'list_tasks', { search: 'Bulk', limit: 5 })
    eq(bulk.count, 1001, 'list_tasks counts all 1,001 tasks: reads page past max_rows')
    ok(audit.some(a => a.path === '/rest/v1/posts' && a.range === '1000-1999'), 'with a second Range page')

    // --------------------------------------------------- minting and the keys
    ok(auth.mints >= 2, 'the endpoint minted sessions through generate_link (one per user)')
    ok(auth.verifyTypes.includes('magiclink') && auth.verifyTypes.includes('email'), "verify was retried with type 'email' when 'magiclink' was refused")
    const serviceOnPosts = audit.filter(a => a.role === 'service_role' && /^\/rest\/v1\/(posts|rpc\/sync_posts)/.test(a.path)).map(a => a.path)
    eq(serviceOnPosts.join(', '), '', 'the hosted path never read or wrote posts with the service key')
    ok(audit.some(a => a.role === 'authenticated' && a.path === '/rest/v1/rpc/sync_posts'), "it wrote with the user's own session")
    const allowed = /^\/(rest\/v1\/rpc\/(agent_token_use|oauth_[a-z_]+|agent_token_rotate)|rest\/v1\/(agent_tokens|oauth_clients|oauth_codes|user_settings)|auth\/v1\/admin\/.+)$/
    const stray = audit.filter(a => a.role === 'service_role' && !allowed.test(a.path)).map(a => `${a.method} ${a.path}`)
    eq(stray.join(', '), '', 'the service key touched only the agent tables, user_settings and the admin auth API')

    // ------------------------------------------------------------- OAuth, end to end
    const REDIRECT = 'http://127.0.0.1:4567/callback'
    const form = fields => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
    const registered = await fetch(`${site.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Smoke assistant', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })
    eq(registered.status, 201, 'dynamic registration makes a public client')
    const client = await registered.json()
    const app = { authorization: `Bearer user:${OWNER}`, 'content-type': 'application/json' }
    async function consent(verifier) {
      const params = new URLSearchParams({
        response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:5678/callback',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        state: 'smoke-state', resource: MCP_URL, scope: 'read write',
      })
      const answer = await (await fetch(`${site.url}/api/oauth/approve`, { method: 'POST', headers: app, body: JSON.stringify({ params: params.toString(), decision: 'allow', scopes: ['read', 'write'], timezone: MACHINE_TZ }) })).json()
      return new URL(answer.redirect)
    }
    const described = await (await fetch(`${site.url}/api/oauth/request`, {
      method: 'POST', headers: app,
      body: JSON.stringify({ params: new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' }).toString() }),
    })).json()
    ok(described.ok && described.clientName === 'Smoke assistant' && described.loopback === true, 'the consent request names the client and a loopback return')
    const refusedConsent = await fetch(`${site.url}/api/oauth/request`, { method: 'POST', headers: app, body: JSON.stringify({ params: `response_type=code&client_id=${client.client_id}&redirect_uri=https%3A%2F%2Fevil.example%2Fcb` }) })
    eq(refusedConsent.status, 400, 'a request for an unregistered redirect is refused')
    ok((await refusedConsent.json()).redirect === undefined, 'and never redirects')

    const verifier = randomBytes(32).toString('base64url')
    const back = await consent(verifier)
    eq(`${back.origin}${back.pathname}`, 'http://127.0.0.1:5678/callback', 'consent returns to the loopback redirect, on the port the client used')
    eq(back.searchParams.get('state'), 'smoke-state', 'with the state')
    eq(back.searchParams.get('iss'), site.url, 'and the issuer (RFC 9207)')
    const code = back.searchParams.get('code')
    eq(psqlJson(`select to_json(count(*)) from public.oauth_codes where code_hash = ${lit(sha256(code))}`), 1, 'the code is stored as its hash')
    const exchange = await fetch(`${site.url}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:5678/callback', client_id: client.client_id, code_verifier: verifier, resource: MCP_URL }))
    eq(exchange.status, 200, 'the token endpoint exchanges the code with PKCE')
    eq(exchange.headers.get('cache-control'), 'no-store', 'and says no-store')
    const pair = await exchange.json()
    ok(pair.access_token?.startsWith('drft_at_') && pair.refresh_token?.startsWith('drft_rt_') && pair.expires_in === 3600, 'a Bearer pair with an hour-long access token')
    const oauthTools = await listHttp(pair.access_token)
    eq(oauthTools.length, 21, 'the OAuth connection (read and write) sees 21 tools')
    const viaOauth = JSON.parse((await callHttp(pair.access_token, 'create_task', { title: 'Via OAuth' })).text).created
    eq(row(viaOauth.id)?.user_id, OWNER, 'a task written with the OAuth token belongs to the user who consented')
    eq(psqlJson(`select to_json(kind || ' ' || name || ' ' || redirect_host) from public.agent_tokens where access_hash = ${lit(sha256(pair.access_token))}`), 'oauth Smoke assistant 127.0.0.1', 'the connection is listed as the client, returning to this computer')

    const refreshed = await (await fetch(`${site.url}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: client.client_id }))).json()
    ok(refreshed.access_token && refreshed.access_token !== pair.access_token && refreshed.refresh_token !== pair.refresh_token, 'the refresh token rotates into a new pair')
    eq((await postMcp(pair.access_token, ping())).status, 401, 'the old access token stops working at once')
    eq((await postMcp(refreshed.access_token, ping())).status, 200, 'the new one works')
    eq((await fetch(`${site.url}/oauth/revoke`, form({ token: refreshed.refresh_token, client_id: client.client_id }))).status, 200, 'revocation answers 200')
    eq((await postMcp(refreshed.access_token, ping())).status, 401, 'and the connection is gone')

    const verifier2 = randomBytes(32).toString('base64url')
    const code2 = (await consent(verifier2)).searchParams.get('code')
    const exchange2 = form({ grant_type: 'authorization_code', code: code2, redirect_uri: 'http://127.0.0.1:5678/callback', client_id: client.client_id, code_verifier: verifier2 })
    const pair2 = await (await fetch(`${site.url}/oauth/token`, exchange2)).json()
    eq((await postMcp(pair2.access_token, ping())).status, 200, 'a second consent makes a working connection')
    eq((await fetch(`${site.url}/oauth/token`, exchange2)).status, 400, 'replaying its code is refused')
    eq((await postMcp(pair2.access_token, ping())).status, 401, 'and revokes the connection the code made')

    // ---------------------------------------- revoked in Settings → Assistants
    ok(await agentauth.revokeConnection(OWNER, ownerTok.connection.id), 'revokeConnection revokes the owner\'s token')
    const afterRevoke = await proxy.rpc('tools/list')
    eq(afterRevoke.error?.code, -32001, 'the next call through the proxy is -32001')
    ok(/Settings → Assistants/.test(afterRevoke.error?.message ?? ''), 'naming where to make a new token')

    console.log(`mcp-smoke: PASS (${step} assertions)`)
  } finally {
    child.stdin.end()
    child.kill()
    if (proxy) {
      proxy.child.stdin.end()
      proxy.child.kill()
    }
    for (const s of [server, site?.server].filter(Boolean)) {
      s.closeAllConnections?.()
      s.close()
    }
  }
}

process.on('exit', stopDatabase)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

try {
  await main()
} catch (e) {
  console.error(`mcp-smoke: ${e?.message ?? e}`)
  process.exitCode = 1
} finally {
  stopDatabase()
}
