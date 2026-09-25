import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSON_ONLY } from '../../shared/ai.mts'
import { visibleItemsFor } from '../../shared/digest.mts'
import { readableRow } from '../../shared/kinds.mts'
import { buildFillPrompt, draftRowState, fillInputFor, recipeDraftId } from '../../shared/recipefill.mts'
import { MAX_TRIES, NIGHTLY_LIMIT, PLANNED_DAYS, planRecipeDrafts, recipeNightAccounts, recipeNightStarts, runRecipeDrafts } from '../../netlify/functions/lib/recipedrafts.mjs'
import { fillPlan, readyDraftOf } from '../recipefill'
import { sanitizeItem } from '../schema'
import type { Recipe, RecipeDraftRecord } from '../types'

// Recipe drafts made overnight (v3.35). Most recipes are a bare name, so the
// grocery list cannot build itself from the plan, and drafting one while
// someone waits takes most of a minute. The nightly job drafts them ahead of
// time: the household's bare recipes, planned ones first, ten a night, each
// written as its recipe's own owner, never over a skip, a save or the recipe
// itself. The model is stubbed at its module — nothing here reaches NVIDIA —
// and the database is a fake that keeps what the job writes, answering as
// PostgREST and sync_posts_as (v3.34) answer.

const { ai } = vi.hoisted(() => ({
  ai: {
    provider: 'nvidia' as string | null,
    asks: [] as { system: string; prompt: string; json?: boolean; reasoning?: string; background?: boolean; maxTokens?: number; deadline?: number }[],
    /** What the model answers the nth ask (1-based), from its prompt. */
    answer: null as null | ((prompt: string, n: number) => { text?: string; error?: string; status?: number }),
    /** What happens elsewhere while the model is asked: a phone's save, a skip. */
    during: null as null | ((prompt: string) => void),
  },
}))
const MODEL = 'nvidia/nemotron-3-super-120b-a12b'
vi.mock('../../netlify/functions/lib/ai.mjs', () => ({
  resolveProvider: () => ai.provider,
  complete: async (input: { system: string; prompt: string; onModel?: (m: string) => void }) => {
    ai.asks.push(structuredClone({ ...input, onModel: undefined }))
    ai.during?.(input.prompt)
    const out = ai.answer!(input.prompt, ai.asks.length)
    if (typeof out.text === 'string') input.onModel?.(MODEL)
    return out
  },
}))
vi.mock('../../netlify/functions/push.mjs', () => ({
  pushConfigured: () => true,
  sendToAll: async () => ({ gone: [], failed: [], updated: [] }),
}))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import digestFunction from '../../netlify/functions/digest.mjs'
// @ts-expect-error — as above
import { aiJobsHandler } from '../../netlify/functions/ai-jobs-background.mjs'

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const JOBS_URL = 'https://site.test/.netlify/functions/ai-jobs-background'
const JOE = 'a1b2c3d4-0000-4000-8000-0000000000aa'
const MARIA = 'e5f6a7b8-0000-4000-8000-0000000000bb'
const STRANGER = 'c0ffee00-0000-4000-8000-0000000000cc'
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 3am on Friday 25 September 2026 in Phoenix, which keeps no daylight saving. */
const NIGHT = '2026-09-25T10:00:00.000Z'
const TODAY = '2026-09-25'
const STAMP = '2026-09-01T00:00:00.000Z'
const runDigest = digestFunction as () => Promise<Response>
const jobs = aiJobsHandler as () => (req: Request) => Promise<Response>

type Row = { user_id: string | null; data: Record<string, any> }
let rows: Row[]
let settings: Record<string, any>[]
let households: { household_id: string; user_id: string }[]
/** Every sync_posts_as call: whose, and what. */
let writes: { owner: string; items: Record<string, any>[] }[]
let jobRuns: Map<string, Record<string, any>>
/** Each job the digest started, as the background function read it. */
let started: Record<string, any>[]
/** record_kinds lists recipedraft: the v3.35 migration is applied. */
let kindStored: boolean
/** The database predates v3.34: PostgREST has no sync_posts_as. */
let writeAsMissing: boolean
/** Each hand-over PATCH: which row, to whom. */
let handOvers: { id: string; user_id: string }[]

const at = (day: number, hour = 0) => new Date(Date.parse(NIGHT) + day * DAY + hour * HOUR)
const dayKey = (days: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10)
const row = (user_id: string | null, data: Record<string, unknown>): Row => ({ user_id, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
const recipe = (owner: string, id: string, name: string, over: Record<string, unknown> = {}) => row(owner, { kind: 'recipe', id, name, ingredients: [], tags: [], ...over })
const meal = (owner: string, date: string, recipeId: string, over: Record<string, unknown> = {}) =>
  row(owner, { kind: 'meal', id: `meal~${date}~dinner~${owner}~${recipeId}`, date, slot: 'dinner', title: 'Dinner', recipeId, ...over })
const draft = (owner: string, recipeId: string, over: Record<string, unknown> = {}) => row(owner, { kind: 'recipedraft', id: recipeDraftId(recipeId), recipeId, ingredients: [], steps: [], ...over })
const drafted = (recipeId: string) => rows.find(r => r.data.id === recipeDraftId(recipeId)) ?? null
const phoenix = (user_id: string, over: Record<string, unknown> = {}) => ({ user_id, timezone: 'America/Phoenix', digest_hour: 8, push_subscriptions: [], digest_email: false, nudged: {}, ...over })
const dishOf = (prompt: string) => /^Dish: (.*)$/m.exec(prompt)?.[1] ?? '?'
const good = (prompt: string) => ({
  text: JSON.stringify({ servings: 4, ingredients: [{ name: `${dishOf(prompt).toLowerCase()} base`, qty: 1, unit: 'pounds' }, { name: 'onion', qty: 1, unit: '' }], steps: [`1. Cook the ${dishOf(prompt)}.`] }),
})
const job = (userIds: string[], when: Date = new Date(NIGHT)) => {
  vi.setSystemTime(when)
  return runRecipeDrafts({ type: 'recipe-drafts', userIds, at: when.toISOString() })
}
const dishesAsked = () => ai.asks.map(a => dishOf(a.prompt))

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('URL', 'https://site.test')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NIGHT))
  ai.provider = 'nvidia'
  ai.asks.length = 0
  ai.answer = good
  ai.during = null
  rows = []
  settings = [phoenix(JOE), phoenix(MARIA), phoenix(STRANGER)]
  households = [
    { household_id: 'home', user_id: JOE },
    { household_id: 'home', user_id: MARIA },
  ]
  writes = []
  jobRuns = new Map()
  started = []
  kindStored = true
  writeAsMissing = false
  handOvers = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === JOBS_URL) {
        // the background function, reached as Netlify reaches it: its real handler, the signature checked
        const res = await jobs()(new Request(url, init))
        if (res.status === 200) started.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: res.status === 200 ? 202 : res.status })
      }
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = url.slice(REST.length)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (path === 'user_settings?select=*') return Response.json(settings)
      if (path === 'user_settings?select=user_id,timezone') return Response.json(settings.map(s => ({ user_id: s.user_id, timezone: s.timezone ?? null })))
      if (path === 'rpc/owner_user_id') return Response.json(JOE)
      if (path === 'rpc/sync_canary') return Response.json({ ok: true, checked: 24, failures: [] })
      if (path.startsWith('app_config?key=eq.sync_canary')) return Response.json([])
      if (path === 'app_config?on_conflict=key' && method === 'POST') return new Response(null, { status: 201 })
      if (path.startsWith('job_runs?job=eq.')) {
        const name = path.slice('job_runs?job=eq.'.length).split('&')[0]
        return Response.json(jobRuns.has(name) ? [jobRuns.get(name)] : [])
      }
      if (path === 'job_runs?on_conflict=job' && method === 'POST') {
        jobRuns.set(body.job, body)
        return new Response(null, { status: 201 })
      }
      if (path === 'household_members?select=household_id,user_id') return Response.json(households)
      if (path === 'rpc/record_kind_allowed' && method === 'POST') return Response.json(body?.p_kind === 'recipedraft' && kindStored)
      if (path.startsWith('posts?select=id,data,user_id&') && method === 'GET') {
        const q = new URLSearchParams(path.slice(path.indexOf('?') + 1))
        // a recipe and its draft, read again: whatever they are now, deleted or not
        const named = /^in\.\((.*)\)$/.exec(q.get('id') ?? '')?.[1].split(',')
        if (named) return Response.json(structuredClone(rows.filter(r => named.includes(r.data.id)).map(r => ({ id: r.data.id, ...r }))))
        // restAll, as PostgREST answers it: the kinds asked for, live ones only when it says so, after the id it carried on from, in id order
        const kind = q.get('kind') ?? ''
        const kinds = /^in\.\((.*)\)$/.exec(kind)?.[1].split(',') ?? (kind.startsWith('eq.') ? [kind.slice(3)] : null)
        const live = q.get('deleted') === 'is.false'
        const after = q.get('id')?.replace(/^gt\./, '') ?? null
        const found = rows
          .filter(r => (!kinds || kinds.includes(r.data.kind ?? 'task')) && (!live || !r.data.deletedAt) && (after === null || r.data.id > after))
          .sort((a, b) => (a.data.id < b.data.id ? -1 : 1))
        const page = found.slice(0, Number(q.get('limit') ?? 1000)).map(r => ({ id: r.data.id, ...structuredClone(r) }))
        return new Response(JSON.stringify(page), { headers: { 'content-range': page.length ? `0-${page.length - 1}/${found.length}` : `*/${found.length}` } })
      }
      if (path === 'rpc/sync_posts_as' && method === 'POST' && writeAsMissing) {
        return Response.json({ code: 'PGRST202', message: 'Could not find the function public.sync_posts_as(incoming, p_owner) in the schema cache' }, { status: 404 })
      }
      if (path === 'rpc/sync_posts' && method === 'POST') {
        // as the service key's sync_posts writes: a new row is the site owner's until it is handed over
        for (const item of body.incoming) {
          const stored = rows.find(r => r.data.id === item.id)
          if (!stored) rows.push({ user_id: JOE, data: structuredClone(item) })
          else if (item.updatedAt > stored.data.updatedAt) stored.data = structuredClone(item)
        }
        return Response.json({ items: [], rejected: [], stale: [], gone: [] })
      }
      if (path.startsWith('posts?id=eq.') && method === 'PATCH') {
        const id = decodeURIComponent(path.slice('posts?id=eq.'.length))
        handOvers.push({ id, user_id: body.user_id })
        const stored = rows.find(r => r.data.id === id)
        if (stored) stored.user_id = body.user_id
        return new Response(null, { status: 204 })
      }
      if (path === 'rpc/sync_posts_as' && method === 'POST') {
        // as the database does since v3.34: a new row is the named owner's from
        // the start, a row of anyone else's is refused, the strictly newer write
        // wins, and a different one that loses is answered stale
        writes.push({ owner: body.p_owner, items: structuredClone(body.incoming) })
        const rejected: string[] = []
        const stale: string[] = []
        for (const item of body.incoming) {
          const stored = rows.find(r => r.data.id === item.id)
          if (item.kind === 'recipedraft' && !kindStored) rejected.push(item.id)
          else if (stored && stored.user_id !== body.p_owner) rejected.push(item.id)
          else if (!stored) rows.push({ user_id: body.p_owner, data: structuredClone(item) })
          else if (item.updatedAt > stored.data.updatedAt) stored.data = structuredClone(item)
          else if (JSON.stringify(item) !== JSON.stringify(stored.data)) stale.push(item.id)
        }
        return Response.json({ items: [], rejected, stale, gone: [] })
      }
      if (path.startsWith('posts?deleted=eq.true') && method === 'DELETE') return new Response(null, { status: 204 })
      throw new Error(`unexpected ${method} ${path}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// ---- what it drafts, and as whom ----------------------------------------------------

describe('a night’s drafts', () => {
  it('drafts the household’s bare recipes, each as its recipe’s owner, and never writes a recipe', async () => {
    rows = [
      recipe(JOE, 'chili', 'Chili', { notes: 'The beans are in the pantry' }),
      recipe(MARIA, 'tacos', 'Tacos', { servings: 2 }),
      recipe(JOE, 'pasta', 'Pasta', { ingredients: [{ id: 'i1', name: 'spaghetti', qty: 1, unit: 'lb' }] }),
      recipe(MARIA, 'gone', 'Gone soup', { deletedAt: STAMP }),
      recipe(JOE, 'blank', '   '),
      recipe(STRANGER, 'theirs', 'Their curry'),
    ]
    const before = structuredClone(rows)
    const out = await job([JOE])
    expect(out.counts).toMatchObject({ asked: 2, drafted: 2 })
    expect(out.failures).toEqual([])
    expect(dishesAsked().sort()).toEqual(['Chili', 'Tacos'])
    // written as each recipe's owner, through sync_posts_as, and nothing else
    expect(writes.map(w => [w.owner, w.items.map(i => i.id)]).sort()).toEqual([
      [JOE, ['recipedraft~chili']],
      [MARIA, ['recipedraft~tacos']],
    ])
    expect(drafted('chili')!.user_id).toBe(JOE)
    expect(drafted('tacos')!.user_id).toBe(MARIA)
    // what was drafted, when, and by which model
    expect(drafted('chili')!.data).toMatchObject({
      kind: 'recipedraft',
      recipeId: 'chili',
      servings: 4,
      ingredients: [{ name: 'chili base', qty: 1, unit: 'lb' }, { name: 'onion', qty: 1 }],
      steps: ['Cook the Chili.'],
      draftedAt: NIGHT,
      triedAt: NIGHT,
      model: MODEL,
    })
    // never a recipe: every recipe row is exactly as it was
    expect(rows.filter(r => r.data.kind === 'recipe')).toEqual(before.filter(r => r.data.kind === 'recipe'))
    expect(writes.flatMap(w => w.items).every(i => i.kind === 'recipedraft')).toBe(true)
    // and the job's own record says so
    expect(jobRuns.get('recipe-drafts')).toMatchObject({ ok: true, counts: { asked: 2, drafted: 2, noAnswer: 0, steppedAside: 0, removed: 0, waiting: 0 } })
  })

  it('on a database before v3.34, still ends up its recipe’s owner’s: written, then handed over', async () => {
    writeAsMissing = true
    rows = [recipe(MARIA, 'tacos', 'Tacos'), recipe(JOE, 'chili', 'Chili')]
    const out = await job([JOE])
    expect(out.counts).toMatchObject({ drafted: 2 })
    expect(handOvers.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'recipedraft~chili', user_id: JOE },
      { id: 'recipedraft~tacos', user_id: MARIA },
    ])
    expect([drafted('tacos')!.user_id, drafted('chili')!.user_id]).toEqual([MARIA, JOE])
  })

  it('asks exactly as the app asks: its prompt and brief, JSON, no thinking, in the background', async () => {
    const chili = recipe(JOE, 'chili', 'Chili', { notes: 'Broccoli is in the foil packet <b>', steps: ['Brown the beef'], servings: 6, tags: ['winter'] })
    rows = [chili]
    await job([JOE])
    const want = buildFillPrompt(fillInputFor(chili.data))
    expect(ai.asks).toHaveLength(1)
    expect(ai.asks[0]).toMatchObject({ system: want.system, prompt: want.prompt, json: true, reasoning: 'off', background: true, maxTokens: 2048 })
    // a deadline of its own, inside the run's
    expect(ai.asks[0].deadline).toBeGreaterThan(Date.parse(NIGHT))
    expect(ai.asks[0].deadline).toBeLessThanOrEqual(Date.parse(NIGHT) + 120_000)
  })

  it('is read by whoever can read the recipe, and by nobody else', async () => {
    rows = [recipe(MARIA, 'tacos', 'Tacos')]
    await job([JOE])
    const saved = drafted('tacos')!
    // the household's, as a recipe is: its owner, their housemate, never a stranger
    expect(readableRow(saved.data, saved.user_id, MARIA)).toBe(true)
    expect(readableRow(saved.data, saved.user_id, JOE)).toBe(true)
    expect(visibleItemsFor(rows, JOE, [JOE, MARIA]).map(i => i.id)).toContain('recipedraft~tacos')
    expect(visibleItemsFor(rows, STRANGER, [STRANGER]).map(i => i.id)).toEqual([])
    // and the app reads it as a draft waiting, ready at once
    const record = sanitizeItem({ ...saved.data, ownerId: saved.user_id }) as RecipeDraftRecord
    expect(record).toMatchObject({ kind: 'recipedraft', recipeId: 'tacos', ownerId: MARIA, model: MODEL })
    expect(readyDraftOf(record)).toEqual({ servings: 4, ingredients: [{ name: 'tacos base', qty: 1, unit: 'lb' }, { name: 'onion', qty: 1 }], steps: ['Cook the Tacos.'] })
    const tacos = sanitizeItem({ ...rows[0].data }) as Recipe
    expect(fillPlan([tacos], [record])).toEqual({ queue: [tacos], ready: 1, skipped: [] })
  })

  it('is somebody’s night only at 3, 4 and 5 in the morning where they are', () => {
    const phx = { timezone: 'America/Phoenix' }
    expect([9, 10, 11, 12, 13].map(h => recipeNightStarts(phx, new Date(Date.UTC(2026, 8, 25, h))))).toEqual([false, true, true, true, false])
    // no settings row reads as UTC
    expect([2, 3, 5, 6].map(h => recipeNightStarts({}, new Date(Date.UTC(2026, 8, 25, h))))).toEqual([false, true, true, false])
  })
})

// ---- which, and in what order -------------------------------------------------------

describe('the order and the nightly limit', () => {
  const plan = (named: string[] = [JOE], when = new Date(NIGHT)) => {
    const drafts = rows.filter(r => r.data.kind === 'recipedraft')
    const live = rows.filter(r => r.data.kind !== 'recipedraft' && !r.data.deletedAt)
    return planRecipeDrafts({
      rows: live,
      drafts,
      settings: settings as { user_id: string; timezone: string }[],
      peers: new Map([
        [JOE, new Set([JOE, MARIA])],
        [MARIA, new Set([JOE, MARIA])],
      ]),
      named,
      at: when,
    })
  }
  const picked = (p = plan()) => p.groups.flatMap(g => g.picks.map(x => String(x.recipe.id)))

  it('planned in the next fourteen days first, soonest first; then ★ favourites; then the most recently saved', () => {
    rows = [
      recipe(JOE, 'old', 'Old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      recipe(JOE, 'new', 'New', { updatedAt: '2026-09-20T00:00:00.000Z' }),
      recipe(MARIA, 'newer', 'Newer', { updatedAt: '2026-09-22T00:00:00.000Z' }),
      recipe(JOE, 'star', 'Star', { favourite: true, updatedAt: '2026-02-01T00:00:00.000Z' }),
      recipe(MARIA, 'star2', 'Star two', { favourite: true, updatedAt: '2026-03-01T00:00:00.000Z' }),
      recipe(JOE, 'tonight', 'Tonight', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      recipe(JOE, 'week', 'In a week'),
      recipe(MARIA, 'fortnight', 'Last day of the window'),
      recipe(JOE, 'later', 'Beyond the window'),
      recipe(JOE, 'past', 'Planned last week'),
      recipe(JOE, 'side', 'A side'),
      meal(JOE, dayKey(0), 'tonight'),
      meal(MARIA, dayKey(7), 'week'),
      meal(JOE, dayKey(PLANNED_DAYS - 1), 'fortnight'),
      meal(JOE, dayKey(PLANNED_DAYS), 'later'),
      meal(JOE, dayKey(-7), 'past'),
      // a side counts as the grocery list counts it
      meal(MARIA, dayKey(3), 'week', { sides: [{ recipeId: 'side', title: 'A side' }] }),
      // a bought meal cooks nothing
      meal(JOE, dayKey(1), 'star', { out: true }),
    ]
    // (a tie on when it was saved goes by id, so every run agrees)
    expect(picked()).toEqual(['tonight', 'side', 'week', 'fortnight', 'star2', 'star', 'newer', 'new', 'later', 'past'])
    // …ten of the eleven: the one saved longest ago waits for another night
    expect(plan().groups[0]).toMatchObject({ room: NIGHTLY_LIMIT, waiting: 1 })
  })

  it('drafts ten a night, however often the night’s runs go, and the rest the next night', async () => {
    rows = Array.from({ length: 13 }, (_, i) => recipe(i % 2 ? JOE : MARIA, `r${String(i).padStart(2, '0')}`, `Dish ${i}`, { updatedAt: new Date(Date.parse(STAMP) + i * HOUR).toISOString() }))
    const first = await job([JOE, MARIA])
    expect(first.counts).toMatchObject({ asked: NIGHTLY_LIMIT, drafted: NIGHTLY_LIMIT, waiting: 3 })
    // the most recently saved first
    expect(dishesAsked()).toEqual(['Dish 12', 'Dish 11', 'Dish 10', 'Dish 9', 'Dish 8', 'Dish 7', 'Dish 6', 'Dish 5', 'Dish 4', 'Dish 3'])
    // 4 and 5 in the morning, and a rerun: nothing more tonight
    await job([JOE, MARIA], at(0, 1))
    await job([JOE, MARIA], at(0, 2))
    await job([JOE, MARIA], at(0, 2))
    expect(ai.asks).toHaveLength(NIGHTLY_LIMIT)
    expect(rows.filter(r => r.data.kind === 'recipedraft')).toHaveLength(NIGHTLY_LIMIT)
    // runs that found nothing to do leave the record of the one that drafted
    expect(jobRuns.get('recipe-drafts')).toMatchObject({ ok: true, ran_at: NIGHT, counts: { drafted: NIGHTLY_LIMIT, waiting: 3 } })
    // the next night, the three left
    const next = await job([JOE], at(1))
    expect(next.counts).toMatchObject({ asked: 3, drafted: 3, waiting: 0 })
    expect(rows.filter(r => r.data.kind === 'recipedraft')).toHaveLength(13)
    // and after that there is nothing to do
    await job([JOE], at(2))
    expect(ai.asks).toHaveLength(13)
  })

  it('leaves alone a draft waiting, one skipped, one saved; tries a tried one again another night, three nights at most', () => {
    const lastNight = at(-1).toISOString()
    rows = [
      recipe(JOE, 'waiting', 'Waiting'),
      recipe(JOE, 'skipped', 'Skipped'),
      recipe(JOE, 'saved', 'Saved, then its ingredients taken out'),
      recipe(JOE, 'again', 'Tried last night'),
      recipe(JOE, 'enough', 'Tried enough'),
      recipe(JOE, 'tonight', 'Tried tonight'),
      recipe(JOE, 'theirs', 'Marked by Maria, then brought back'),
      recipe(JOE, 'none', 'No draft yet'),
      draft(JOE, 'waiting', { ingredients: [{ name: 'x' }], steps: ['y'], draftedAt: lastNight, triedAt: lastNight }),
      draft(MARIA, 'skipped', { ingredients: [{ name: 'x' }], skippedAt: lastNight, skippedBy: MARIA }),
      draft(JOE, 'saved', { deletedAt: lastNight, purged: true }),
      draft(JOE, 'again', { triedAt: lastNight, tries: 1 }),
      draft(JOE, 'enough', { triedAt: at(-3).toISOString(), tries: MAX_TRIES }),
      draft(JOE, 'tonight', { triedAt: at(0, -1).toISOString(), tries: 1 }),
      draft(MARIA, 'theirs', {}),
    ]
    const p = plan()
    expect(picked(p).sort()).toEqual(['again', 'none', 'theirs'])
    // a row already there is written as whoever holds it; a new one as the recipe's owner
    expect(Object.fromEntries(p.groups[0].picks.map(x => [x.recipe.id, x.writer]))).toEqual({ again: JOE, none: JOE, theirs: MARIA })
    // the one tried tonight counts against tonight's ten
    expect(p.groups[0].room).toBe(NIGHTLY_LIMIT - 1)
  })

  it('reads as the recipe’s owner reads: a housemate’s Just-me meal, or a stranger’s, never moves a recipe up', () => {
    rows = [
      recipe(MARIA, 'soup', 'Soup', { updatedAt: '2026-09-20T00:00:00.000Z' }),
      recipe(MARIA, 'stew', 'Stew', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      // Joe keeps tomorrow's soup to himself: Maria's queue cannot see it
      meal(JOE, dayKey(1), 'soup', { shared: false }),
      meal(STRANGER, dayKey(0), 'soup'),
      // her own dinner in five days is hers to see
      meal(MARIA, dayKey(5), 'stew'),
    ]
    expect(picked()).toEqual(['stew', 'soup'])
    // shared with her, the soup comes first
    rows[2] = meal(JOE, dayKey(1), 'soup', { shared: true })
    expect(picked()).toEqual(['soup', 'stew'])
  })

  it('works only for the households whose night it is', () => {
    rows = [recipe(JOE, 'chili', 'Chili'), recipe(STRANGER, 'curry', 'Curry')]
    expect(picked(plan([STRANGER]))).toEqual(['curry'])
    expect(picked(plan([MARIA]))).toEqual(['chili'])
    expect(picked(plan([]))).toEqual([])
  })
})

// ---- when the model has nothing, or fails ----------------------------------------------

describe('an answer with nothing in it, and a model that fails', () => {
  it('asks once more with the app’s own nudge, then notes it and tries another night — three nights at most', async () => {
    rows = [recipe(JOE, 'mystery', 'Mystery')]
    // NVIDIA's JSON mode, whole and empty
    ai.answer = () => ({ text: '{"":""}' })
    const out = await job([JOE])
    expect(out.counts).toMatchObject({ asked: 1, drafted: 0, noAnswer: 1 })
    expect(ai.asks.map(a => a.system.endsWith(`\n\n${JSON_ONLY}`))).toEqual([false, true])
    expect(drafted('mystery')!.data).toMatchObject({ ingredients: [], steps: [], triedAt: NIGHT, tries: 1 })
    expect(drafted('mystery')!.data.draftedAt).toBeUndefined()
    // the app reads it as nothing waiting: the sheet drafts it live, as before
    const record = sanitizeItem(drafted('mystery')!.data) as RecipeDraftRecord
    expect(draftRowState(record)).toBe('tried')
    expect(readyDraftOf(record)).toBeUndefined()
    // not again tonight
    await job([JOE], at(0, 1))
    expect(ai.asks).toHaveLength(2)
    // again the next two nights, and then no more
    await job([JOE], at(1))
    await job([JOE], at(2))
    expect(drafted('mystery')!.data.tries).toBe(MAX_TRIES)
    await job([JOE], at(3))
    expect(ai.asks).toHaveLength(2 * MAX_TRIES)
    // a later night's answer that is a draft replaces the note
    rows = [recipe(JOE, 'mystery2', 'Mystery two'), draft(JOE, 'mystery2', { triedAt: at(-1).toISOString(), tries: 1 })]
    ai.answer = good
    await job([JOE])
    expect(drafted('mystery2')!.data).toMatchObject({ steps: ['Cook the Mystery two.'], draftedAt: NIGHT })
    expect(drafted('mystery2')!.data.tries).toBeUndefined()
  })

  it('a model that fails stops the run with nothing written, and the next hour asks again', async () => {
    rows = [recipe(JOE, 'a', 'Apple crumble', { updatedAt: '2026-09-02T00:00:00.000Z' }), recipe(JOE, 'b', 'Beef stew')]
    ai.answer = () => ({ status: 429, error: 'NVIDIA rate limit hit' })
    const out = await job([JOE])
    expect(out.counts).toMatchObject({ asked: 1, drafted: 0 })
    expect(out.failures).toEqual(['a: NVIDIA rate limit hit'])
    expect(ai.asks).toHaveLength(1)
    expect(writes).toEqual([])
    expect(jobRuns.get('recipe-drafts')).toMatchObject({ ok: false, failures: ['a: NVIDIA rate limit hit'] })
    // 4am: the model is back
    ai.answer = good
    const again = await job([JOE], at(0, 1))
    expect(again.counts).toMatchObject({ asked: 2, drafted: 2 })
    expect(jobRuns.get('recipe-drafts')).toMatchObject({ ok: true })
  })

  it('without the v3.35 migration it asks the model nothing, and says why', async () => {
    rows = [recipe(JOE, 'a', 'Apple crumble')]
    kindStored = false
    const out = await job([JOE])
    expect(ai.asks).toEqual([])
    expect(out.failures).toEqual(['the database does not store recipe drafts yet: the v3.35 migration is not applied'])
  })
})

// ---- never over anyone -----------------------------------------------------------------

describe('what changes while it works', () => {
  it('steps aside from a recipe filled in, or skipped, while the model was asked', async () => {
    rows = [recipe(JOE, 'a', 'Apple crumble', { updatedAt: '2026-09-02T00:00:00.000Z' }), recipe(MARIA, 'b', 'Beef stew')]
    ai.during = prompt => {
      if (dishOf(prompt) === 'Apple crumble') {
        // Joe typed its ingredients on his phone meanwhile
        const a = rows.find(r => r.data.id === 'a')!
        a.data = { ...a.data, ingredients: [{ id: 'i', name: 'apples', qty: 6 }], updatedAt: '2026-09-25T10:00:30.000Z' }
      } else {
        // and Maria skipped the stew in the sheet
        rows.push(draft(MARIA, 'b', { skippedAt: NIGHT, skippedBy: MARIA, updatedAt: NIGHT }))
      }
    }
    const out = await job([JOE])
    expect(out.counts).toMatchObject({ asked: 2, drafted: 0, steppedAside: 2 })
    expect(writes).toEqual([])
    expect(rows.find(r => r.data.id === 'a')!.data.ingredients).toEqual([{ id: 'i', name: 'apples', qty: 6 }])
    expect(drafted('b')!.data).toEqual(draft(MARIA, 'b', { skippedAt: NIGHT, skippedBy: MARIA, updatedAt: NIGHT }).data)
  })

  it('removes a draft whose recipe was deleted or filled in, as whoever holds the draft', async () => {
    rows = [
      recipe(JOE, 'filled', 'Filled in', { ingredients: [{ id: 'i', name: 'eggs', qty: 2 }] }),
      recipe(MARIA, 'binned', 'Binned', { deletedAt: STAMP }),
      recipe(JOE, 'kept', 'Still bare'),
      draft(JOE, 'filled', { ingredients: [{ name: 'eggs' }], draftedAt: STAMP }),
      draft(MARIA, 'binned', { ingredients: [{ name: 'beans' }], draftedAt: STAMP }),
      // Maria skipped Joe's recipe; it has been deleted since
      draft(MARIA, 'purged-recipe', { skippedAt: STAMP }),
      draft(JOE, 'kept', { ingredients: [{ name: 'rice' }], draftedAt: STAMP }),
      // another household's, not tonight's to touch
      draft(STRANGER, 'nowhere', { ingredients: [{ name: 'x' }] }),
    ]
    const before = structuredClone(rows.filter(r => r.data.kind === 'recipe'))
    const out = await job([JOE])
    expect(out.counts).toMatchObject({ removed: 3, asked: 0 })
    expect(writes.map(w => [w.owner, w.items.map(i => i.id)]).sort()).toEqual([
      [JOE, ['recipedraft~filled']],
      [MARIA, ['recipedraft~binned']],
      [MARIA, ['recipedraft~purged-recipe']],
    ])
    for (const id of ['filled', 'binned', 'purged-recipe']) {
      const gone = drafted(id)!.data
      // "Delete forever"'s tombstone: nothing left of what it drafted
      expect(gone).toEqual({ kind: 'recipedraft', id: recipeDraftId(id), deletedAt: NIGHT, purged: true, createdAt: NIGHT, updatedAt: NIGHT })
      expect(sanitizeItem(gone)).toMatchObject({ kind: 'recipedraft', recipeId: id, ingredients: [], steps: [], deletedAt: NIGHT })
    }
    expect(drafted('kept')!.data.deletedAt).toBeUndefined()
    expect(drafted('nowhere')!.data.deletedAt).toBeUndefined()
    expect(rows.filter(r => r.data.kind === 'recipe')).toEqual(before)
  })
})

// ---- how it is started ------------------------------------------------------------------

describe('the hourly digest starts it', () => {
  it('at 3, 4 and 5 in the morning where the household is, subscribed or not, and the drafts land', async () => {
    rows = [recipe(JOE, 'chili', 'Chili'), recipe(MARIA, 'tacos', 'Tacos')]
    for (let t = Date.parse('2026-09-25T07:00:00Z'); t <= Date.parse('2026-09-25T14:00:00Z'); t += HOUR) {
      vi.setSystemTime(new Date(t))
      await runDigest()
    }
    expect(started.map(j => [j.type, j.at])).toEqual([
      ['recipe-drafts', '2026-09-25T10:00:00.000Z'],
      ['recipe-drafts', '2026-09-25T11:00:00.000Z'],
      ['recipe-drafts', '2026-09-25T12:00:00.000Z'],
    ])
    expect(started[0].userIds.sort()).toEqual([JOE, MARIA].sort())
    // the first drafted both; the others found nothing left to do, and left its record
    expect(ai.asks).toHaveLength(2)
    expect([drafted('chili')!.user_id, drafted('tacos')!.user_id]).toEqual([JOE, MARIA])
    expect(jobRuns.get('recipe-drafts')).toMatchObject({ ok: true, ran_at: '2026-09-25T10:00:00.000Z', counts: { drafted: 2 } })
    expect(jobRuns.get('digest')).toMatchObject({ ok: true })
  })

  it('not while every recipe has its ingredients, nor for a household whose night it is not', async () => {
    rows = [recipe(JOE, 'pasta', 'Pasta', { ingredients: [{ id: 'i', name: 'spaghetti' }] }), recipe(STRANGER, 'curry', 'Curry')]
    settings = [phoenix(JOE), phoenix(MARIA), phoenix(STRANGER, { timezone: 'Europe/London' })]
    vi.setSystemTime(new Date(NIGHT))
    await runDigest()
    expect(started).toEqual([])
    expect(recipeNightAccounts(settings, rows, new Map([[JOE, new Set([JOE, MARIA])]]), new Date(NIGHT))).toEqual([])
    // 3am in London is the stranger's
    vi.setSystemTime(new Date('2026-09-25T02:00:00Z'))
    await runDigest()
    expect(started.map(j => j.userIds)).toEqual([[STRANGER]])
  })

  it('and the job refuses anyone the digest named out of their night', async () => {
    rows = [recipe(JOE, 'chili', 'Chili')]
    const out = await job([JOE], new Date('2026-09-25T20:00:00Z'))
    expect(ai.asks).toEqual([])
    expect(out.counts.asked).toBe(0)
  })
})
