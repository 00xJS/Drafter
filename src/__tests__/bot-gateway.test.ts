import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// The bot gateway (supabase/functions/bot/index.ts) is a Deno edge function
// that imports supabase-js from jsr:, so it cannot run here as it stands. This
// compiles its own source with TypeScript, hands it a stand-in for Deno and
// for supabase-js's client — a table of rows answering the few queries the
// gateway makes, and whatever sync_posts answer a test chooses — and calls the
// handler it registers, as a bot would.

const SOURCE = readFileSync(fileURLToPath(new URL('../../supabase/functions/bot/index.ts', import.meta.url)), 'utf8')
const IMPORT = "import { createClient } from 'jsr:@supabase/supabase-js@2'"
const TOKEN = 'correct horse battery staple'
const OWNER = '00000000-0000-0000-0000-00000000000a'
const PEER = '00000000-0000-0000-0000-00000000000b'
const STAMP = '2026-09-14T10:00:00.000Z'

type Row = { id: string; user_id: string | null; data: Record<string, unknown> }
type Handler = (req: Request) => Promise<Response>
type Answer = (incoming: Record<string, unknown>[]) => Record<string, unknown>

const row = (user_id: string | null, data: Record<string, unknown>): Row => ({ id: String(data.id), user_id, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })

/**
 * A column as PostgREST reads it: posts' kind and deleted are generated from
 * the data; household_members rows are plain. `data->key` projects a JSON
 * value and `data->>key` its text form — the gateway selects
 * `shared:data->shared`, and a stand-in that answered undefined for that would
 * make every stored note test as unshared. The next person to write "the bot
 * may edit a peer's note the peer shared" would watch it fail and go looking
 * for a bug in working code.
 */
function column(r: any, col: string): unknown {
  if (!('data' in r)) return r[col]
  if (col === 'kind') return typeof r.data.kind === 'string' ? r.data.kind : 'task'
  if (col === 'deleted') return 'deletedAt' in r.data
  if (col === 'status') return r.data.status
  const json = /^data->(>?)([A-Za-z0-9_]+)$/.exec(col)
  if (json) {
    const v = r.data[json[2]]
    // ->> is text: PostgREST gives the JSON boolean true back as the string "true"
    return json[1] === '>' ? (v === undefined || v === null ? null : String(v)) : (v ?? null)
  }
  return r[col]
}

/** `alias:expr` as a select item gives, as PostgREST does, the alias as the key. */
function projected(item: string): { key: string; col: string } {
  const at = item.indexOf(':')
  return at === -1 ? { key: item, col: item } : { key: item.slice(0, at), col: item.slice(at + 1) }
}

/** A filter list split at its top-level commas: or=(a,b,and(c,d)). */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** One condition of the scope filter the gateway builds: col.is.null, col.eq.x, col.neq.x, col.in.(…), col.not.in.(…), and(…) or or(…). */
function holds(cond: string, r: any): boolean {
  if (cond.startsWith('and(')) return splitTop(cond.slice(4, -1)).every(c => holds(c, r))
  // each per-record rule is a nested or() inside that and(): a note's
  // (kind.neq.note, data->>shared.eq.true) and a task's
  // (kind.neq.task, data->>shared.is.null, data->>shared.neq.false)
  if (cond.startsWith('or(')) return splitTop(cond.slice(3, -1)).some(c => holds(c, r))
  const [col, ...rest] = cond.split('.')
  const negate = rest[0] === 'not'
  const [op, ...args] = negate ? rest.slice(1) : rest
  const arg = args.join('.')
  const v = column(r, col)
  let result: boolean
  if (op === 'is' && arg === 'null') result = v === null
  else if (op === 'eq') result = v !== null && String(v) === arg
  // SQL, not JavaScript: NULL is not unequal to anything, so a row whose
  // `shared` is absent does NOT match neq.false. That is exactly why the task
  // rule carries an is.null term of its own, and a stand-in that were lenient
  // here would let a filter pass the tests and drop rows in production.
  else if (op === 'neq') result = v !== null && String(v) !== arg
  else if (op === 'in') result = arg.replace(/^\(|\)$/g, '').split(',').includes(String(v))
  else throw new Error(`the stand-in has no operator ${op}`)
  return negate ? !result : result
}

/** sync_posts under the service role: every row in the table echoed, each with its owner, and nothing stale or gone. */
const echo =
  (rows: Row[]): Answer =>
  incoming => ({
    items: [...rows.map(r => ({ ...r.data, ownerId: r.user_id })), ...incoming.map(i => ({ ...i, ownerId: OWNER }))],
    rejected: [],
    stale: [],
    gone: [],
  })

/**
 * The gateway, compiled from its source and run against these rows: `call`
 * posts a body with the bot's token. `extraEnv` adds to (or replaces) what the
 * stand-in Deno hands it — an empty value unsets that variable, as Deno answers
 * undefined for one never set — and `keys` records the key each client was made with.
 */
function gateway(rows: Row[], answer: Answer = echo(rows), extraEnv: Record<string, string> = {}) {
  if (!SOURCE.includes(IMPORT)) throw new Error('the gateway no longer imports supabase-js the way this stand-in replaces it')
  const synced: Record<string, unknown>[][] = []
  const members = [
    { household_id: 'h1', user_id: OWNER },
    { household_id: 'h1', user_id: PEER },
  ]
  const from = (table: string) => {
    let out: any[] = table === 'posts' ? [...rows] : table === 'household_members' ? [...members] : []
    let cols: string[] = []
    let limit = Infinity
    const q = {
      select: (c: string) => ((cols = c.split(',')), q),
      eq: (col: string, v: unknown) => ((out = out.filter(r => column(r, col) === v)), q),
      in: (col: string, vs: unknown[]) => ((out = out.filter(r => vs.includes(column(r, col)))), q),
      or: (filter: string) => ((out = out.filter(r => splitTop(filter).some(c => holds(c, r)))), q),
      order: () => q,
      limit: (n: number) => ((limit = n), q),
      then: (resolve: (v: unknown) => unknown) =>
        resolve({
          data: out.slice(0, limit).map(r =>
            Object.fromEntries(
              cols.map(c => {
                const { key, col } = projected(c)
                return [key, col === 'data' ? r.data : column(r, col)]
              }),
            ),
          ),
          error: null,
        }),
    }
    return q
  }
  const client = {
    from,
    rpc: async (fn: string, args: { incoming: Record<string, unknown>[] }) => {
      if (fn === 'owner_user_id') return { data: OWNER, error: null }
      if (fn !== 'sync_posts') return { data: null, error: { message: `the stand-in has no function ${fn}` } }
      synced.push(args.incoming)
      return { data: answer(args.incoming), error: null }
    },
  }
  const env: Record<string, string> = { BOT_TOKEN: TOKEN, SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', ...extraEnv }
  for (const [k, v] of Object.entries(env)) if (v === '') delete env[k]
  const box: { handler?: Handler } = {}
  const keys: string[] = []
  const opts: any[] = []
  const deno = { env: { get: (k: string) => env[k] }, serve: (h: Handler) => void (box.handler = h) }
  const js = ts.transpileModule(SOURCE.replace(IMPORT, 'const { createClient } = supabase'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  new Function('Deno', 'supabase', js)(deno, { createClient: (...args: any[]) => (keys.push(args[1]), opts.push(args[2]), client) })
  const call = async (body: unknown, token = TOKEN) => {
    const res = await box.handler!(new Request('https://gateway.test/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-token': token }, body: JSON.stringify(body) }))
    return { status: res.status, json: (await res.json()) as any }
  }
  return { call, synced, keys, opts }
}

const idsOf = (list: { id: string }[]) => list.map(p => p.id)

describe('the gateway, run from its own source', () => {
  it('reads the database with the key Supabase injects, when it has none of its own', async () => {
    const rows = [row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' })]
    const { call, keys } = gateway(rows)
    const { status } = await call({ action: 'list' })
    expect(status).toBe(200)
    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys)).toEqual(new Set(['service-key']))
  })

  it('sends a key of the new style in the apikey header alone, because Supabase reads it as a JWT otherwise', async () => {
    const rows = [row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' })]
    const { call, opts } = gateway(rows, echo(rows), { BOT_DB_KEY: 'sb_secret_abc' })
    await call({ action: 'list' })
    const wrapped = opts.find(o => o?.global?.fetch)?.global.fetch
    expect(wrapped, 'a new-style key gets a fetch that drops the Bearer header').toBeTypeOf('function')
    const seen: Headers[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => (seen.push(new Headers(init.headers)), new Response('{}'))) as typeof fetch
    try {
      await wrapped('https://db.example.test/rest/v1/posts', { headers: { apikey: 'sb_secret_abc', Authorization: 'Bearer sb_secret_abc', 'content-type': 'application/json' } })
    } finally {
      globalThis.fetch = real
    }
    expect(seen[0].get('Authorization')).toBeNull()
    expect(seen[0].get('apikey')).toBe('sb_secret_abc')
    expect(seen[0].get('content-type')).toBe('application/json')
  })

  it('leaves a legacy key alone, Bearer and all, so nothing changes until the project moves', async () => {
    const rows = [row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' })]
    const { call, opts, keys } = gateway(rows, echo(rows), { BOT_DB_KEY: 'eyJhbGciOiJIUzI1NiJ9.legacy' })
    await call({ action: 'list' })
    expect(new Set(keys)).toEqual(new Set(['eyJhbGciOiJIUzI1NiJ9.legacy']))
    expect(opts.some(o => o?.global?.fetch), 'a legacy key needs no wrapper').toBe(false)
  })

  it('prefers its own BOT_DB_KEY, so the project can retire the injected one', async () => {
    const rows = [row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' })]
    const { call, keys } = gateway(rows, echo(rows), { BOT_DB_KEY: 'bot-key' })
    const { status, json } = await call({ action: 'list' })
    expect(status).toBe(200)
    expect(idsOf(json.posts)).toEqual(['mine'])
    expect(new Set(keys)).toEqual(new Set(['bot-key']))
  })

  it('says which secret to set when it has no key at all, rather than building a client from undefined', async () => {
    const rows = [row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' })]
    const { call, keys } = gateway(rows, echo(rows), { SUPABASE_SERVICE_ROLE_KEY: '' })
    const { status, json } = await call({ action: 'list' })
    expect(status).toBe(500)
    expect(json.error).toMatch(/BOT_DB_KEY/)
    // and nothing was built with an undefined key, to fail obscurely on its first query
    expect(keys).toEqual([])
  })

  it('reads what the owner may: their own rows and the household\'s shared ones, never a peer\'s wardrobe', async () => {
    const { call } = gateway([
      row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' }),
      row(PEER, { kind: 'task', id: 'bins', title: 'Bins', status: 'todo' }),
      row(PEER, { kind: 'garment', id: 'peer-shirt', name: 'Theirs', type: 'top' }),
    ])
    const { status, json } = await call({ action: 'list' })
    expect(status).toBe(200)
    expect(idsOf(json.posts).sort()).toEqual(['bins', 'mine'])
  })

  // A note is its author's until they share it (v3.16). The gateway runs as the
  // service role, so RLS never sees it — inScope and scopeFilter are the whole
  // enforcement, and nothing else stands between an agent and a private note.
  it('never hands an agent a peer’s note the peer kept to themselves', async () => {
    const { call, json } = await (async () => {
      const g = gateway([
        row(OWNER, { kind: 'note', id: 'mine', title: 'Mine', body: '<p>mine</p>' }),
        row(PEER, { kind: 'note', id: 'peer-open', title: 'Theirs', body: '<p>shared</p>', shared: true }),
        row(PEER, { kind: 'note', id: 'peer-shut', title: 'Private', body: '<p>PEER-PRIVATE</p>' }),
        row(PEER, { kind: 'note', id: 'peer-false', title: 'Also private', body: '<p>PEER-PRIVATE</p>', shared: false }),
      ])
      return { call: g.call, json: (await g.call({ action: 'list' })).json }
    })()
    void call
    expect(idsOf(json.posts).sort()).toEqual(['mine', 'peer-open'])
    expect(JSON.stringify(json)).not.toContain('PEER-PRIVATE')
  })

  // v3.19 gives a task the same per-record audience, the other way round: the
  // household's unless its owner withheld it. The gateway is again the whole
  // enforcement, and here the filter has to let the ordinary tasks THROUGH —
  // most carry no flag at all, and `neq.false` alone would drop every one.
  it('hands an agent the household’s tasks and not the one a peer kept to themselves', async () => {
    const { call } = gateway([
      row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' }),
      row(PEER, { kind: 'task', id: 'peer-open', title: 'Theirs', status: 'todo' }),
      row(PEER, { kind: 'task', id: 'peer-true', title: 'Shared out loud', status: 'todo', shared: true }),
      row(PEER, { kind: 'task', id: 'peer-shut', title: 'PEER-PRIVATE', status: 'todo', shared: false }),
    ])
    const { json } = await call({ action: 'list' })
    expect(idsOf(json.posts).sort()).toEqual(['mine', 'peer-open', 'peer-true'])
    expect(JSON.stringify(json)).not.toContain('PEER-PRIVATE')
  })

  it('refuses a write onto a peer’s private task, and one that would make a shared task private', async () => {
    const { call } = gateway([
      row(PEER, { kind: 'task', id: 'peer-shut', title: 'Theirs', status: 'todo', shared: false }),
      row(PEER, { kind: 'task', id: 'peer-open', title: 'Theirs', status: 'todo' }),
    ])
    const { json } = await call({
      action: 'sync',
      posts: [
        { kind: 'task', id: 'peer-shut', title: 'Mine now', status: 'todo', updatedAt: STAMP },
        { kind: 'task', id: 'peer-open', title: 'Theirs', status: 'todo', shared: false, updatedAt: STAMP },
      ],
    })
    expect((json.posts as { rejected: string[] }).rejected.sort()).toEqual(['peer-open', 'peer-shut'])
  })

  it('counts only readable rows against the limit, so a peer’s private notes cannot crowd out the answer', async () => {
    // The limit is applied by the database. With the note rule left to inScope
    // alone, a page of a peer's private notes came back, was thrown away, and
    // the agent was told — truthfully and uselessly — that there was nothing.
    const wall = Array.from({ length: 5 }, (_, i) => row(PEER, { kind: 'note', id: `p${i}`, title: `P${i}`, body: '<p>x</p>' }))
    const { call } = gateway([...wall, row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' })])
    const { json } = await call({ action: 'list', limit: 3 })
    expect(idsOf(json.posts)).toEqual(['mine'])
  })

  it('refuses a write that would land on a peer’s private note, and one that would un-share a shared one', async () => {
    const { call } = gateway([
      row(PEER, { kind: 'note', id: 'peer-shut', title: 'Private', body: '<p>theirs</p>' }),
      row(PEER, { kind: 'note', id: 'peer-open', title: 'Shared', body: '<p>theirs</p>', shared: true }),
    ])
    const { json } = await call({
      action: 'sync',
      posts: [
        { kind: 'note', id: 'peer-shut', title: 'Mine now', body: '', shared: true, updatedAt: STAMP },
        // the same shape BOTS.md documents, with no `shared`: it would make somebody else's note private
        { kind: 'note', id: 'peer-open', title: 'Shared', body: '<p>edited</p>', updatedAt: STAMP },
      ],
    })
    expect((json.posts as { rejected: string[] }).rejected.sort()).toEqual(['peer-open', 'peer-shut'])
  })

  it('lets an agent edit a peer’s shared note when the write keeps it shared', async () => {
    const { call, synced } = gateway([row(PEER, { kind: 'note', id: 'peer-open', title: 'Shared', body: '<p>theirs</p>', shared: true })])
    const { json } = await call({
      action: 'sync',
      posts: [{ kind: 'note', id: 'peer-open', title: 'Shared', body: '<p>edited</p>', shared: true, updatedAt: STAMP }],
    })
    expect((json.posts as { rejected: string[] }).rejected).toEqual([])
    expect(synced[0].map(p => p.id)).toEqual(['peer-open'])
  })

  it('refuses a wrong token before it reads or writes anything', async () => {
    const { call, synced } = gateway([row(OWNER, { kind: 'task', id: 'mine', title: 'Mine', status: 'todo' })])
    expect((await call({ action: 'sync', posts: [{ kind: 'task', id: 'x', updatedAt: STAMP }] }, 'wrong')).status).toBe(401)
    expect(synced).toEqual([])
  })
})

describe('a sync says which writes lost to a newer edit, and which hit a record deleted for good', () => {
  it('passes sync_posts\' stale and gone lists through, with the newer copy among the items', async () => {
    const rows = [row(OWNER, { kind: 'task', id: 'mine', title: 'Newer', status: 'todo', updatedAt: '2026-09-14T11:00:00.000Z' })]
    const { call } = gateway(rows, () => ({ items: rows.map(r => ({ ...r.data, ownerId: r.user_id })), rejected: [], stale: ['mine'], gone: ['purged'] }))
    const { json } = await call({
      action: 'sync',
      posts: [
        { kind: 'task', id: 'mine', title: 'Older', status: 'todo', updatedAt: STAMP },
        { kind: 'task', id: 'purged', title: 'Back again?', status: 'todo', updatedAt: STAMP },
      ],
    })
    expect(json.posts).toMatchObject({ rejected: [], stale: ['mine'], gone: ['purged'] })
    expect(json.posts.items.find((i: { id: string }) => i.id === 'mine')?.title).toBe('Newer')
  })

  it('answers empty lists when sync_posts gives none (a database before v3.11)', async () => {
    const { call } = gateway([], () => ({ items: [], rejected: [] }))
    expect((await call({ action: 'sync', posts: [] })).json.posts).toEqual({ items: [], rejected: [], stale: [], gone: [] })
  })
})

describe('a bot cannot start a second project', () => {
  const LIFE = row(OWNER, { kind: 'project', id: 'life', name: 'LIFE', status: 'active' })

  it('refuses a new project while the account has one, and still edits the one it has', async () => {
    const { call, synced } = gateway([LIFE])
    const { json } = await call({
      action: 'sync',
      posts: [
        { kind: 'project', id: 'life', name: 'LIFE', status: 'active', notes: 'Edited by a bot', updatedAt: '2026-09-14T12:00:00.000Z' },
        { kind: 'project', id: 'side-hustle', name: 'Side hustle', status: 'active', updatedAt: STAMP },
        { kind: 'task', id: 'new-task', title: 'A task', status: 'todo', updatedAt: STAMP },
      ],
    })
    expect(idsOf(synced[0] as { id: string }[])).toEqual(['life', 'new-task'])
    expect(json.posts.rejected).toEqual(['side-hustle'])
  })

  it('counts the household\'s project: a peer\'s LIFE is the account\'s one project too', async () => {
    const { call, synced } = gateway([row(PEER, { kind: 'project', id: 'their-life', name: 'LIFE', status: 'active' })])
    const { json } = await call({ action: 'sync', posts: [{ kind: 'project', id: 'another', name: 'Another', status: 'active', updatedAt: STAMP }] })
    expect(synced[0]).toEqual([])
    expect(json.posts.rejected).toEqual(['another'])
  })

  it('refuses another record rewritten as a project, and a project brought back from Trash, while LIFE is live', async () => {
    // sync_posts keeps a stored id and takes the new data whatever its kind, so either would be a second live project
    const later = '2026-09-14T12:00:00.000Z'
    const { call, synced } = gateway([
      LIFE,
      row(OWNER, { kind: 'task', id: 'a-task', title: 'A task', status: 'todo' }),
      row(OWNER, { kind: 'project', id: 'old', name: 'Old', status: 'done', deletedAt: STAMP }),
    ])
    const { json } = await call({
      action: 'sync',
      posts: [
        { kind: 'project', id: 'a-task', name: 'Side hustle', status: 'active', updatedAt: later },
        { kind: 'project', id: 'old', name: 'Old', status: 'active', updatedAt: later },
        { kind: 'project', id: 'life', name: 'LIFE', status: 'active', notes: 'Still editable', updatedAt: later },
      ],
    })
    expect(idsOf(synced[0] as { id: string }[])).toEqual(['life'])
    expect(json.posts.rejected).toEqual(['a-task', 'old'])
  })

  it('brings a trashed LIFE back when no project is live', async () => {
    const { call, synced } = gateway([row(OWNER, { kind: 'project', id: 'life', name: 'LIFE', status: 'active', deletedAt: STAMP })])
    const { json } = await call({ action: 'sync', posts: [{ kind: 'project', id: 'life', name: 'LIFE', status: 'active', updatedAt: '2026-09-14T12:00:00.000Z' }] })
    expect(idsOf(synced[0] as { id: string }[])).toEqual(['life'])
    expect(json.posts.rejected).toEqual([])
  })

  it('names a refused id once, even when two rules refuse it', async () => {
    // a peer's personal row is out of reach, and rewriting it as a project would also be a second one
    const { call } = gateway([LIFE, row(PEER, { kind: 'habit', id: 'their-habit', name: 'Run' })])
    const { json } = await call({ action: 'sync', posts: [{ kind: 'project', id: 'their-habit', name: 'Mine now', status: 'active', updatedAt: '2026-09-14T12:00:00.000Z' }] })
    expect(json.posts.rejected).toEqual(['their-habit'])
  })

  it('with no live project, lets the first new one in and refuses the rest of the batch', async () => {
    const { call, synced } = gateway([row(OWNER, { kind: 'project', id: 'old', name: 'Old', status: 'done', deletedAt: STAMP })])
    const { json } = await call({
      action: 'sync',
      posts: [
        { kind: 'project', id: 'first', name: 'LIFE', status: 'active', updatedAt: STAMP },
        { kind: 'project', id: 'second', name: 'More', status: 'active', updatedAt: STAMP },
      ],
    })
    expect(idsOf(synced[0] as { id: string }[])).toEqual(['first'])
    expect(json.posts.rejected).toEqual(['second'])
  })
})
