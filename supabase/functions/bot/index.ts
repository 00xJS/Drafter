// Scoped bot gateway: automations authenticate with BOT_TOKEN (a shared
// secret set via `supabase secrets set`) instead of the service_role key.
// The token can only read posts and write through the LWW-merged sync RPC —
// it cannot touch auth, app_config (ownership), storage, or anything else.
//
// The bot acts as the site owner, but the service role behind it bypasses
// every policy, so the gateway applies the owner's view itself: the owner's
// rows (and legacy unowned ones) plus household members' rows of shared
// kinds — never a member's journal, review, calendar subscription, habit,
// routine or wardrobe, and nothing belonging to anyone outside the household.
//
// A sync answers { posts: { items, rejected, stale, gone } }: the rows the bot
// may read; the ids refused; the ids whose write lost to a newer edit (the
// newer copy is among the items, whatever `since` was); and the ids deleted
// for good. Drafter keeps one project, so while the account has a live one a
// write that would make a second is refused too — a new project, another
// record rewritten as one, or one brought back from Trash — as the app never
// makes a second.

import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * The key this gateway reads the database with: its own `BOT_DB_KEY` when one
 * is set, and otherwise the service-role key Supabase injects. Supabase keeps
 * the `SUPABASE_` prefix for its own variables, so the bot's key cannot share
 * it. Setting `BOT_DB_KEY` lets the project's legacy keys be retired without
 * taking the bot down with them.
 */
function dbKey(): string {
  return Deno.env.get('BOT_DB_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
}

/** The service-role client. Typed from this call: `ReturnType<typeof createClient>` resolves its generics to never. */
function adminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, dbKey())
}
type Admin = ReturnType<typeof adminClient>

/**
 * Kinds that belong to one account even inside a household — the set
 * src/store.ts, shared/digest.mjs and mcp/server.mjs use. An edge function
 * cannot import shared/, so src/__tests__/mcp.test.ts holds this copy to theirs.
 */
const PERSONAL_KINDS = new Set(['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear'])

/** The owner the bot acts as, and the other members of the owner's households. */
type Scope = { owner: string | null; peers: string[] }

async function scopeOf(admin: Admin): Promise<Scope> {
  const { data: owner, error } = await admin.rpc('owner_user_id')
  if (error) throw new Error(error.message)
  if (typeof owner !== 'string') return { owner: null, peers: [] }
  const mine = await admin.from('household_members').select('household_id').eq('user_id', owner)
  if (mine.error) throw new Error(mine.error.message)
  const households = (mine.data ?? []).map(r => String(r.household_id))
  if (households.length === 0) return { owner, peers: [] }
  const members = await admin.from('household_members').select('user_id').in('household_id', households)
  if (members.error) throw new Error(members.error.message)
  const peers = new Set((members.data ?? []).map(r => String(r.user_id)))
  peers.delete(owner)
  return { owner, peers: [...peers] }
}

/**
 * The posts policy as the owner meets it (migration 20260915): their own rows
 * and legacy unowned ones, and a household member's unless the kind is
 * personal. The same test decides what a read returns and which existing rows
 * a write may land on.
 */
function inScope(scope: Scope, userId: unknown, kind: unknown): boolean {
  if (userId === null || (scope.owner !== null && userId === scope.owner)) return true
  return typeof userId === 'string' && scope.peers.includes(userId) && !PERSONAL_KINDS.has(typeof kind === 'string' ? kind : 'task')
}

/** The same rule as a PostgREST filter, so `limit` counts only rows the bot may read. */
function scopeFilter(scope: Scope): string {
  const branches = ['user_id.is.null']
  if (scope.owner) branches.push(`user_id.eq.${scope.owner}`)
  if (scope.peers.length) branches.push(`and(user_id.in.(${scope.peers.join(',')}),kind.not.in.(${[...PERSONAL_KINDS].join(',')}))`)
  return branches.join(',')
}

type Post = { id: string; kind?: unknown; deletedAt?: unknown }
/** The rows already stored under a batch's ids: whose each one is, what kind, and whether it is in Trash. */
type Stored = Map<string, { user_id: string | null; kind: string; deleted: boolean }>

/** The posts in a write batch that carry an id. */
function postsOf(incoming: unknown[]): Post[] {
  return incoming.filter((p): p is Post => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
}

async function storedRows(admin: Admin, incoming: unknown[]): Promise<Stored> {
  const ids = [...new Set(postsOf(incoming).map(p => p.id))]
  const stored: Stored = new Map()
  // a page of ids per request keeps the query string short
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin.from('posts').select('id,user_id,kind,deleted').in('id', ids.slice(i, i + 100))
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as { id: string; user_id: string | null; kind: string; deleted: boolean }[]) {
      stored.set(r.id, { user_id: r.user_id, kind: r.kind, deleted: r.deleted === true })
    }
  }
  return stored
}

/**
 * Ids in a write batch that already belong to a row the owner could not write
 * in the app: a member's personal row, a member's shared row being turned
 * into a personal one, or anything outside the household. The service role
 * would let sync_posts land on those; RLS would not, so they come back in
 * `rejected` like any refused write while the rest of the batch stores.
 */
function refusedIds(scope: Scope, incoming: unknown[], stored: Stored): string[] {
  const kinds = new Map(postsOf(incoming).map(p => [p.id, p.kind]))
  return [...stored].filter(([id, r]) => !inScope(scope, r.user_id, r.kind) || !inScope(scope, r.user_id, kinds.get(id))).map(([id]) => id)
}

/**
 * Writes in a batch that would make a second live project. Drafter keeps one
 * ongoing project (LIFE) and nothing in the app starts another, so neither
 * may a bot. A live project already stored can still be edited; anything else
 * that would be a live project after the write — a new one, another record
 * rewritten as one (sync_posts keeps a stored id and takes the new data
 * whatever its kind) or a project brought back from Trash — stores only while
 * the owner can see no live project: the first of the batch, and no more.
 * They come back in `rejected` too.
 */
async function extraProjects(admin: Admin, scope: Scope, incoming: unknown[], stored: Stored): Promise<string[]> {
  const liveProject = (id: string) => {
    const r = stored.get(id)
    return !!r && r.kind === 'project' && !r.deleted
  }
  const fresh = [...new Set(postsOf(incoming).filter(p => p.kind === 'project' && !p.deletedAt && !liveProject(p.id)).map(p => p.id))]
  if (fresh.length === 0) return []
  const { data, error } = await admin.from('posts').select('id').eq('kind', 'project').eq('deleted', false).or(scopeFilter(scope)).limit(1)
  if (error) throw new Error(error.message)
  return (data ?? []).length > 0 ? fresh : fresh.slice(1)
}

/**
 * Compare secrets in constant time. Hashing first gives both sides the same
 * length, so neither the loop nor a length check says how close a guess was.
 */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
  const u = new Uint8Array(x)
  const v = new Uint8Array(y)
  let diff = 0
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i]
  return diff === 0
}

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

Deno.serve(async req => {
  if (req.method !== 'POST') return fail(405, 'method not allowed')
  const expected = Deno.env.get('BOT_TOKEN')
  const token = req.headers.get('x-bot-token')
  if (!expected || !token || !(await sameSecret(token, expected))) return fail(401, 'unauthorized')

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail(400, 'invalid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'the body must be a JSON object')
  if (body.action !== 'sync' && body.action !== 'list') return fail(400, 'unknown action (use "sync" or "list")')

  const admin = adminClient()
  let scope: Scope
  try {
    scope = await scopeOf(admin)
  } catch (e) {
    return fail(500, `could not work out whose rows these are: ${(e as Error).message}`)
  }

  // { action: "sync", posts: [...], since?: iso } — LWW-safe write + read
  if (body.action === 'sync') {
    const incoming: unknown[] = Array.isArray(body.posts) ? body.posts : []
    let refused: string[]
    try {
      const stored = await storedRows(admin, incoming)
      // one id can break both rules (a member's personal row rewritten as a project); it is named once
      refused = [...new Set([...refusedIds(scope, incoming, stored), ...(await extraProjects(admin, scope, incoming, stored))])]
    } catch (e) {
      return fail(500, (e as Error).message)
    }
    const { data, error } = await admin.rpc('sync_posts', {
      incoming: incoming.filter(p => !refused.includes((p as { id?: unknown } | null)?.id as string)),
      since: typeof body.since === 'string' ? body.since : null,
    })
    if (error) return fail(500, error.message)
    // under the service role sync_posts echoes every row in the table, each with its ownerId
    const res = data as { items?: unknown; rejected?: unknown; stale?: unknown; gone?: unknown } | null
    if (!res || !Array.isArray(res.items)) return fail(502, 'unexpected sync_posts response')
    const items = (res.items as ({ ownerId?: unknown; kind?: unknown } | null)[]).filter(i => i && inScope(scope, i.ownerId, i.kind))
    const listed = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
    // stale: the write lost to a newer edit, and that copy is among the items;
    // gone: the record was deleted for good, and the write was dropped
    return Response.json({ posts: { items, rejected: [...listed(res.rejected), ...refused], stale: listed(res.stale), gone: listed(res.gone) } })
  }

  // { action: "list", status?, limit? } — filtered read of live posts
  let q = admin.from('posts').select('data,user_id,kind').eq('deleted', false).or(scopeFilter(scope)).order('updated_at', { ascending: false })
  if (typeof body.status === 'string') q = q.eq('status', body.status)
  q = q.limit(Math.min(Math.max(Number(body.limit) || 100, 1), 1000))
  const { data, error } = await q
  if (error) return fail(500, error.message)
  // the filter does the scoping; checking each row again means a mistake in it can only narrow the answer
  const rows = (data ?? []) as { data: unknown; user_id: string | null; kind: string }[]
  return Response.json({ posts: rows.filter(r => inScope(scope, r.user_id, r.kind)).map(r => r.data) })
})
