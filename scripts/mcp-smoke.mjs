#!/usr/bin/env node
// End-to-end smoke test for the MCP server: the real `node mcp/server.mjs`
// process, driven over stdio with newline-delimited JSON-RPC, writing into a
// real Postgres that has every migration applied.
//
// Why this exists: `npm run db:smoke` proves the SQL layer and
// src/__tests__/mcp.test.ts proves the fetch contract against a stub, but
// until now nothing drove the actual server against an actual database. Both
// September bugs — syncWrite not unwrapping { items, rejected }, and the
// ambiguous `id` in sync_posts making every write rejected — would have been
// caught here by the very first create_project.
//
// There is no PostgREST binary on this machine, so this file *is* the
// PostgREST shim: a node:http server that implements exactly the handful of
// requests mcp/server.mjs makes, translates each into SQL and executes it by
// shelling out to psql. Anything it does not implement answers 501 with the
// path — a silent empty array would hide the class of bug this test exists
// to catch.
//
// Run with `npm run mcp:smoke`. Needs the PostgreSQL binaries on PATH; not
// part of `npm run check` (Netlify has no Postgres).

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = '00000000-0000-0000-0000-00000000000a'
const OWNER_EMAIL = 'owner@example.test'

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
 * run as: the shim uses service_role, which is what the Supabase service key
 * resolves to, while the test's own seeding and verification run as the
 * superuser so no grant or policy can mask a row. The result is captured with
 * `\o` so psql's command tags can never contaminate it.
 */
function psqlValue(sql, role = null) {
  const n = queryCount++
  const qfile = join(dbDir, `q${n}.sql`)
  const ofile = join(dbDir, `q${n}.out`)
  writeFileSync(qfile, `${role ? `set role ${role};\n` : ''}\\o ${ofile}\n${sql};\n`)
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
  const res = JSON.parse(psqlValue(`select public.sync_posts(${jsonLit(items)}::jsonb, null)`, 'service_role'))
  if (res.rejected?.length) throw new Error(`mcp-smoke: seed rows rejected: ${res.rejected.join(', ')}`)
}

// ---------------------------------------------------------------------------
// The PostgREST shim
//
// Three routes, because mcp/server.mjs makes exactly three kinds of request:
// GET /rest/v1/posts, POST /rest/v1/rpc/sync_posts and POST
// /rest/v1/rpc/owner_user_id. There is deliberately no PATCH: every write in
// the server goes through the sync_posts RPC, so a PATCH handler here would be
// code no test could ever reach. If one is ever added to the server, this shim
// answers 501 with the path and this test fails — which is the point.
// ---------------------------------------------------------------------------

/** Columns the shim will select on or filter by. Anything else is a 501, not an empty result. */
const COLUMNS = new Set(['id', 'data', 'user_id', 'updated_at', 'synced_at', 'deleted', 'kind', 'status', 'title'])

class Unsupported extends Error {}

/** Test switches: the two response shapes sync_posts has had, and a forced rejection. */
const shim = { syncShape: 'object', rejectAll: false }

function whereClause(params) {
  const conds = []
  for (const [key, raw] of params) {
    // Only select and order are implemented below; limit/offset fall through to
    // the unknown-column branch so paging added to the server fails loudly here
    // instead of quietly reading the whole table.
    if (key === 'select' || key === 'order') continue
    if (!COLUMNS.has(key)) throw new Unsupported(`filter on column "${key}"`)
    const dot = raw.indexOf('.')
    if (dot < 0) throw new Unsupported(`filter "${key}=${raw}" (no operator)`)
    const op = raw.slice(0, dot)
    const arg = raw.slice(dot + 1)
    if (op === 'eq') conds.push(`${key} = ${lit(arg)}`)
    else if (op === 'is' && ['true', 'false', 'null'].includes(arg)) conds.push(`${key} is ${arg}`)
    else throw new Unsupported(`operator "${op}" on "${key}"`)
  }
  return conds.length ? ` where ${conds.join(' and ')}` : ''
}

/** GET /rest/v1/posts — select, eq/is filters and order, translated to SQL. */
function selectPosts(params) {
  const select = params.get('select')
  if (!select || select === '*') throw new Unsupported('select=* (name the columns)')
  const cols = select.split(',').map(c => c.trim())
  for (const c of cols) if (!COLUMNS.has(c)) throw new Unsupported(`select of column "${c}"`)
  const order = params.get('order')
  let window = ''
  if (order) {
    const [col, dir = 'asc'] = order.split('.')
    if (!COLUMNS.has(col) || !['asc', 'desc'].includes(dir)) throw new Unsupported(`order=${order}`)
    window = `order by ${col} ${dir}`
  }
  const obj = `json_build_object(${cols.map(c => `${lit(c)}, ${c}`).join(', ')})`
  return psqlValue(
    `select coalesce(json_agg(j order by ord), '[]'::json)::text from (` +
      `select row_number() over (${window}) as ord, ${obj} as j from public.posts${whereClause(params)}) s`,
    'service_role',
  )
}

function rpcSyncPosts(body) {
  // Same contract as selectPosts / whereClause: a body shape this does not
  // implement is a 501 naming the path, never an empty result. Defaulting to []
  // would write nothing, answer { items: [], rejected: [] }, and have the server
  // report "a newer copy exists" — a merge conflict that never happened,
  // pointing at the wrong thing entirely.
  if (!Array.isArray(body?.incoming)) throw new Unsupported('sync_posts body without an "incoming" array')
  const incoming = body.incoming
  if (shim.rejectAll) {
    // the server must surface this, not report success
    return JSON.stringify({ items: [], rejected: incoming.map(i => i?.id).filter(Boolean) })
  }
  const text = psqlValue(`select public.sync_posts(${jsonLit(incoming)}::jsonb, null)::text`, 'service_role')
  if (shim.syncShape === 'legacy') return JSON.stringify(JSON.parse(text).items ?? [])
  return text
}

function startShim() {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://shim')
      const send = (code, text) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(text)
      }
      const unimplemented = why => send(501, JSON.stringify({ message: `mcp-smoke shim does not implement ${req.method} ${url.pathname}${url.search} — ${why}` }))
      try {
        let body = null
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (req.method === 'GET' && url.pathname === '/rest/v1/posts') return send(200, selectPosts(url.searchParams))
        if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/sync_posts') return send(200, rpcSyncPosts(body))
        if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/owner_user_id') return send(200, psqlValue('select to_json(public.owner_user_id())', 'service_role'))
        return unimplemented('unknown route')
      } catch (e) {
        if (e instanceof Unsupported) return unimplemented(e.message)
        return send(500, JSON.stringify({ message: String(e?.message ?? e) }))
      }
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

// ---------------------------------------------------------------------------
// The MCP server, over stdio
// ---------------------------------------------------------------------------

function startMcp(baseUrl) {
  const child = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SUPABASE_URL: baseUrl, SUPABASE_SERVICE_KEY: 'smoke-test-service-key' },
  })
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
  return { child, rpc, stderr }
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

async function main() {
  console.log('mcp-smoke: starting a throwaway Postgres…')
  startDatabase()
  seedOwner()
  const { server, url } = await startShim()
  const { child, rpc } = startMcp(url)

  /** Call a tool and parse its JSON payload; throws when the server reported an error. */
  async function call(name, args = {}) {
    const res = await rpc('tools/call', { name, arguments: args })
    const text = res.result?.content?.[0]?.text ?? ''
    if (res.result?.isError) throw new Error(`tool ${name} failed: ${text}`)
    if (res.error) throw new Error(`tool ${name}: ${res.error.message}`)
    return JSON.parse(text)
  }
  /** The same, for calls that must fail: returns the error text. */
  async function callFails(name, args = {}) {
    const res = await rpc('tools/call', { name, arguments: args })
    const text = res.result?.content?.[0]?.text ?? ''
    if (!res.result?.isError) throw new Error(`FAIL: ${name} was supposed to fail, returned ${text.slice(0, 200)}`)
    return text
  }

  try {
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

    console.log(`mcp-smoke: PASS (${step} assertions)`)
  } finally {
    child.stdin.end()
    child.kill()
    server.closeAllConnections?.()
    server.close()
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
