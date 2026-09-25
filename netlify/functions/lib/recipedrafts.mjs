// Recipe drafts made overnight (v3.35), for Kitchen → Recipes → Fill them in.
//
// Why. Most saved recipes are a name and nothing else, and the grocery list is
// built from ingredients, so it cannot build itself from the meal plan. Fill
// them in drafts them one at a time while someone waits — and NVIDIA's model
// takes 40 to 60 seconds a draft, so nobody sat through it. Now the bare
// recipes are drafted ahead of time, a few a night, and the sheet shows one
// that is waiting at once. A draft is only a proposal: a record of its own,
// `recipedraft~<recipe id>`, and nothing reaches the recipe until a member
// taps Save.
//
// When. The hourly digest (digest.mjs) names the accounts whose night it is —
// 3, 4 and 5 in the morning where they are — and whose household has a recipe
// still bare, to the background function (ai-jobs-background.mjs), which has
// fifteen minutes where the digest has thirty seconds. The first of those
// hours drafts; the other two carry on where one ran out of time or found the
// model away, and otherwise find nothing left to do.
//
// What. For each household whose night it is: its live, named recipes with no
// ingredients and no draft — planned in the next fourteen days first, soonest
// first, then ★ favourites, then the most recently saved — up to ten a night,
// counted by the asks the night has already made (each draft's `triedAt`), so
// the next hour's run, or a rerun, never makes it eleven. Each is asked with
// the app's own prompt and read by the app's own reader (shared/recipefill.mts);
// a reply with no draft in it is asked for once more, as the app asks, and a
// second with none is noted on the row (`tries`) to try another night — three
// nights at most. A model that fails outright (away, rate-limited, too slow)
// stops the run with nothing written for it: the next hour or night tries again.
//
// Whose. A new draft is written as its recipe's owner (lib/writeas.mjs, v3.34),
// so it is theirs from the instant it exists and reaches exactly whom the
// recipe reaches; one already there is written as whoever holds it. What the
// job reads it reads as that owner would (visibleItemsFor, readableRow): a
// housemate's Just-me meal never moves the owner's recipe up the queue.
//
// Never. It never writes a recipe. A draft a member skipped or saved is left
// alone, and so is one tried enough. The recipe and its draft are read again
// before the model is asked and again before anything is written, and a recipe
// filled in, deleted or skipped meanwhile is stepped aside from. A draft whose
// recipe was deleted, or has ingredients now, is removed: a content-free
// tombstone, written as the draft's own owner. Each run is kept in job_runs
// ('recipe-drafts').
//
// Before the v3.35 migration the database refuses the kind, so a run that
// finds it missing (record_kind_allowed) asks the model nothing and says so
// in its record.

import { JSON_ONLY } from '../../../shared/ai.mts'
import { localParts, visibleItemsFor } from '../../../shared/digest.mts'
import { kindOf } from '../../../shared/kinds.mts'
import { mealRecipeIds, recipeHasIngredients } from '../../../shared/kitchen.mts'
import { FILL_MAX_TOKENS, buildFillPrompt, draftRowState, fillInputFor, recipeDraftId, recipeIdOfDraft, usableDraft } from '../../../shared/recipefill.mts'
import { purgeTombstone } from '../../../shared/tombstone.mts'
import { complete, resolveProvider } from './ai.mjs'
import { startJob } from './aijobs.mjs'
import { rest, restAll } from './backup.mjs'
import { recordJobRun } from './jobhealth.mjs'
import { buildPeerMap } from './peers.mjs'
import { shiftDayKey } from './reviewweek.mjs'
import { validTimeZone } from './timezone.mjs'
import { writeAs } from './writeas.mjs'

const HOUR = 3_600_000

/** Drafts a household is given a night at most: asks of the model, each answered or not. */
export const NIGHTLY_LIMIT = 10
/** A recipe on a meal this many days ahead, today included, is drafted first. */
export const PLANNED_DAYS = 14
/** The night's first hour, where each account is: 3 in the morning. */
export const NIGHT_HOUR = 3
/** The hourly runs a night starts: the first drafts, the others carry on where it could not. */
export const NIGHT_RUNS = 3
/** An ask this recent is tonight's: longer than the night's runs, shorter than a day. */
export const NIGHT_MS = 20 * HOUR
/** Nights a recipe may get nothing usable before the job leaves it to the sheet. */
export const MAX_TRIES = 3
/** One recipe, both of its asks: the model takes 20 to 60 seconds an answer. */
export const DRAFT_MS = 120_000
/** The whole run, inside the background function's fifteen minutes. */
export const JOB_MS = 12 * 60_000
/** A recipe is started only with this much of the run left. */
const START_MIN_MS = 45_000
/** The second ask, for a reply with no draft in it, only with this much of the recipe's time left. */
const RETRY_MIN_MS = 20_000
/** Accounts one run takes at most. */
const MAX_ACCOUNTS = 20

/** An instant on or after `from` (epoch ms). */
const since = (iso, from) => {
  const t = Date.parse(String(iso ?? ''))
  return Number.isFinite(t) && t >= from
}

/** One millisecond after `iso`, or null without a valid one. */
function justAfter(iso) {
  const t = Date.parse(String(iso ?? ''))
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : null
}

/** The later of two instants; `b` may be none. */
const later = (a, b) => (b && Date.parse(b) > Date.parse(a) ? b : a)

/**
 * A recipe the grocery list cannot use and the sheet would offer: live, named,
 * and nothing to shop for (recipeHasIngredients, the Kitchen's own rule).
 * @param {Record<string, any> | null | undefined} data
 */
export function isBareRecipe(data) {
  return !!data && data.kind === 'recipe' && !data.deletedAt && typeof data.name === 'string' && data.name.trim() !== '' && !recipeHasIngredients(data)
}

/**
 * Whether this hourly run is one of an account's night runs: NIGHT_HOUR where
 * it is, and the NIGHT_RUNS - 1 hours after it. `settings` is its
 * user_settings row, or {} for an account with none, which reads as UTC.
 * @param {{ timezone?: string | null } | null | undefined} settings
 * @param {Date} now
 */
export function recipeNightStarts(settings, now) {
  const { hour } = localParts(now, validTimeZone(settings?.timezone) ?? 'UTC')
  return hour !== null && hour >= NIGHT_HOUR && hour < NIGHT_HOUR + NIGHT_RUNS
}

/**
 * The accounts the digest names to the job: those whose night it is and whose
 * household, as they read it, holds a recipe still bare. `accounts` are the
 * digest's own — a settings row each, or { user_id } for one with none — and
 * `rows` its records, read with the service key, so each account is held to
 * what the posts policy would show it (visibleItemsFor).
 * @param {{ user_id?: string | null, timezone?: string | null }[]} accounts
 * @param {{ user_id: string | null, data: unknown }[]} rows
 * @param {Map<string, Set<string>> | null | undefined} peers
 * @param {Date} now
 * @returns {string[]}
 */
export function recipeNightAccounts(accounts, rows, peers, now) {
  const recipes = (rows ?? []).filter(r => kindOf(r?.data) === 'recipe')
  /** @type {string[]} */
  const out = []
  for (const u of accounts ?? []) {
    if (!u?.user_id || !recipeNightStarts(u, now)) continue
    if (visibleItemsFor(recipes, u.user_id, peers?.get(u.user_id)).some(isBareRecipe)) out.push(u.user_id)
  }
  return out
}

/**
 * Hand tonight's recipe drafts for these accounts to the background function.
 * Never throws. Resolves null once it has taken them, or with none to hand
 * over; otherwise what went wrong, for the digest's record.
 * @param {string[]} userIds
 * @param {Date} now
 * @param {string} origin
 * @param {{ start?: typeof startJob }} [opts]
 * @returns {Promise<string | null>}
 */
export async function startRecipeNight(userIds, now, origin, { start = startJob } = {}) {
  const ids = [...new Set((userIds ?? []).filter(id => typeof id === 'string' && id))]
  if (!ids.length) return null
  if (await start({ type: 'recipe-drafts', userIds: ids, at: now.toISOString() }, { origin })) return null
  return `Recipe drafts could not be started for ${ids.length} account(s): the background function did not answer`
}

/**
 * Tonight's work, from what the run read. Pure, so its rules can be held:
 * for each household with a member whose night it is, the recipes to draft —
 * in order, as many as the night has room for — and every live draft of its
 * members' whose recipe was deleted or has ingredients now, to remove.
 *
 * A household is an owner's own read of it (the owner and everyone whose
 * records they may see, buildPeerMap), so its members share one queue and one
 * night's room. A recipe's draft may be anyone's row: one waiting, skipped or
 * removed is left alone, and one the job noted as tried is asked again only
 * on a later night, fewer than MAX_TRIES times, and only if a member holds it.
 * @param {{
 *   rows: { user_id: string | null, data: any }[],
 *   drafts: { user_id: string | null, data: any }[],
 *   settings: { user_id: string, timezone?: string | null }[],
 *   peers: Map<string, Set<string>> | null | undefined,
 *   named: Iterable<string>,
 *   at: Date,
 * }} input `rows` are the live recipes and meals; `drafts` every recipedraft row, removed ones too
 */
export function planRecipeDrafts({ rows, drafts, settings, peers, named, at }) {
  const night = new Set(named)
  const zoneOf = new Map((settings ?? []).map(s => [s.user_id, validTimeZone(s.timezone) ?? 'UTC']))
  const tonight = at.getTime() - NIGHT_MS
  // every live recipe, whoever's: what a draft is checked against
  /** @type {Map<string, { user_id: string, data: any }>} */
  const recipes = new Map()
  for (const r of rows ?? []) if (r?.user_id && kindOf(r.data) === 'recipe' && typeof r.data?.id === 'string' && !r.data.deletedAt) recipes.set(r.data.id, /** @type {{ user_id: string, data: any }} */ (r))
  /** @type {Map<string, { user_id: string | null, data: any }>} */
  const draftById = new Map()
  for (const d of drafts ?? []) if (typeof d?.data?.id === 'string') draftById.set(d.data.id, d)

  // the household of everyone who holds a recipe or a draft, as they read it
  /** @type {Map<string, { key: string, members: string[], owners: Set<string> }>} */
  const households = new Map()
  const holders = new Set([...[...recipes.values()].map(r => r.user_id), ...[...draftById.values()].map(d => d.user_id)])
  for (const owner of holders) {
    if (!owner) continue
    const members = [...new Set([owner, ...(peers?.get(owner) ?? [])])].sort()
    const key = members.join(',')
    const h = households.get(key) ?? { key, members, owners: new Set() }
    h.owners.add(owner)
    households.set(key, h)
  }

  const groups = []
  /** @type {Map<string, { user_id: string | null, data: any }>} */
  const stale = new Map()
  for (const h of households.values()) {
    if (!h.members.some(m => night.has(m))) continue
    const members = new Set(h.members)
    const theirs = [...draftById.values()].filter(d => d.user_id && members.has(d.user_id))
    // a draft whose recipe was deleted, or has ingredients now, has done its work
    for (const d of theirs) {
      if (d.data?.deletedAt) continue
      const recipe = recipes.get(recipeIdOfDraft(d.data?.id) ?? '')
      if (!recipe || recipeHasIngredients(recipe.data)) stale.set(d.data.id, d)
    }
    // the night's asks so far: each draft the job wrote or noted tonight
    const room = Math.max(0, NIGHTLY_LIMIT - theirs.filter(d => since(d.data?.triedAt, tonight)).length)

    const candidates = []
    for (const owner of h.owners) {
      // what the owner may read: their own rows, and the household's that the posts policy would show them
      const seen = visibleItemsFor([...recipes.values(), ...(rows ?? []).filter(r => kindOf(r?.data) === 'meal')], owner, peers?.get(owner))
      const today = localParts(at, zoneOf.get(owner) ?? 'UTC').day ?? at.toISOString().slice(0, 10)
      const last = shiftDayKey(today, PLANNED_DAYS - 1) ?? today
      /** @type {Map<string, string>} recipe id -> the soonest day a meal in the window cooks it */
      const planned = new Map()
      for (const m of seen) {
        if (m.kind !== 'meal' || m.deletedAt || typeof m.date !== 'string' || m.date < today || m.date > last) continue
        for (const id of mealRecipeIds(/** @type {any} */ (m))) {
          const cur = planned.get(id)
          if (!cur || m.date < cur) planned.set(id, m.date)
        }
      }
      for (const r of seen) {
        if (r.ownerId !== owner || !isBareRecipe(r)) continue
        const id = String(r.id)
        const row = draftById.get(recipeDraftId(id)) ?? null
        if (row) {
          // waiting, skipped or removed: nothing to do
          if (draftRowState(row.data ?? {}) !== 'tried') continue
          // noted as tried: again on a later night, a few times, by a member who holds it
          if (!row.user_id || !members.has(row.user_id) || (Number(row.data?.tries) || 0) >= MAX_TRIES || since(row.data?.triedAt, tonight)) continue
        }
        candidates.push({ recipe: r, ownerId: owner, writer: row?.user_id ?? owner, row, plannedOn: planned.get(id) ?? null })
      }
    }
    candidates.sort(
      (a, b) =>
        (a.plannedOn && b.plannedOn ? a.plannedOn.localeCompare(b.plannedOn) : a.plannedOn ? -1 : b.plannedOn ? 1 : 0) ||
        Number(b.recipe.favourite === true) - Number(a.recipe.favourite === true) ||
        (Date.parse(String(b.recipe.updatedAt)) || 0) - (Date.parse(String(a.recipe.updatedAt)) || 0) ||
        String(a.recipe.id).localeCompare(String(b.recipe.id)),
    )
    groups.push({ key: h.key, members: h.members, room, picks: candidates.slice(0, room), waiting: Math.max(0, candidates.length - room) })
  }
  return { groups, stale: [...stale.values()] }
}

/** Whether a stored draft is still the one the run chose: none then and none now, or the same write. */
const sameDraft = (now, then) => (!now && !then) || (!!now && !!then && now.data?.updatedAt === then.data?.updatedAt)

/**
 * Draft one recipe the plan chose, if it still wants one. The recipe and its
 * draft are read again before the model is asked and again before anything is
 * written; the draft is written as `pick.writer`, stamped after any row it
 * replaces. Answers { state }: 'drafted'; 'no answer' (noted on the row, to
 * try another night); 'stepped aside' (filled in, deleted, re-owned, skipped
 * or drafted meanwhile, or the write lost); or 'failed' with `why` — and
 * `stop` when the model itself failed, so the run asks no more tonight.
 * @param {{ recipe: Record<string, any>, ownerId: string, writer: string, row: { user_id: string | null, data: any } | null }} pick
 * @param {{
 *   read: (path: string, init?: RequestInit) => Promise<any>,
 *   write: typeof writeAs,
 *   ask: typeof complete,
 *   deadline: number,
 *   now: () => number,
 * }} ctx
 * @returns {Promise<{ state: 'drafted' | 'no answer' | 'stepped aside' } | { state: 'failed', why: string, stop?: boolean }>}
 */
export async function draftRecipe(pick, { read, write, ask, deadline, now }) {
  const recipeId = String(pick.recipe.id)
  const draftId = recipeDraftId(recipeId)
  const both = async () => {
    const got = await read(`posts?select=id,data,user_id&id=in.(${[recipeId, draftId].map(encodeURIComponent).join(',')})`).catch(() => null)
    if (!Array.isArray(got)) return null
    return { recipe: got.find(r => r?.id === recipeId) ?? null, draft: got.find(r => r?.id === draftId) ?? null }
  }
  /** @param {{ recipe: any, draft: any }} got */
  const wanted = got => !!got.recipe && got.recipe.user_id === pick.ownerId && isBareRecipe(got.recipe.data) && sameDraft(got.draft, pick.row)

  const before = await both()
  if (!before) return { state: 'failed', why: 'the recipe could not be read' }
  if (!wanted(before)) return { state: 'stepped aside' }

  // the app's own prompt, from the recipe as it stands now
  const { system, prompt } = buildFillPrompt(fillInputFor(before.recipe.data))
  /** @type {string | null} */
  let model = null
  /** @param {string} brief */
  const call = brief =>
    ask({
      system: brief,
      prompt,
      maxTokens: FILL_MAX_TOKENS,
      json: true,
      reasoning: 'off',
      // nobody is waiting on it: a second NVIDIA key takes it first, and the owner's own requests keep the main one
      background: true,
      deadline,
      onModel: m => {
        model = m
      },
    }).catch(e => /** @type {import('./ai.mjs').Completion} */ ({ status: 502, error: e?.message ?? String(e) }))
  const first = await call(system)
  if (first.error) return { state: 'failed', why: first.error, stop: true }
  let draft = usableDraft(first.text ?? '')
  // a reply with no draft in it — {"":""}, thinking, nothing — is asked for once more, as the app asks
  if (!draft && deadline - now() >= RETRY_MIN_MS) {
    const again = await call(`${system}\n\n${JSON_ONLY}`)
    if (again.error) return { state: 'failed', why: again.error, stop: true }
    draft = usableDraft(again.text ?? '')
  }

  const after = await both()
  if (!after) return { state: 'failed', why: 'the recipe could not be read again' }
  if (!wanted(after)) return { state: 'stepped aside' }
  const stamp = new Date(now()).toISOString()
  const prev = after.draft?.data ?? null
  const base = { kind: 'recipedraft', id: draftId, recipeId, triedAt: stamp, createdAt: prev?.createdAt ?? stamp, updatedAt: later(stamp, justAfter(prev?.updatedAt)) }
  const row = draft
    ? { ...base, ...(draft.servings ? { servings: draft.servings } : {}), ingredients: draft.ingredients, steps: draft.steps, draftedAt: stamp, ...(model ? { model } : {}) }
    : { ...base, ingredients: [], steps: [], tries: (Number(prev?.tries) || 0) + 1 }
  // a new row, on a database before v3.34, is born the site owner's and handed over after, as Sunday's draft is
  const out = await write(pick.writer, [row], { handOver: !prev })
  if (!out.ok) return { state: 'failed', why: out.why }
  if ([...out.rejected, ...out.stale, ...out.gone].includes(draftId)) return { state: 'stepped aside' }
  return { state: draft ? 'drafted' : 'no answer' }
}

/**
 * The background job: the households of the accounts the digest named, one
 * at a time, while the run has time. `job.at` is the digest's own moment,
 * which decides whose night it is, however late the job runs. `deps` replaces
 * the database, the writer, the model and the clock for the tests.
 * @param {Record<string, unknown>} job `userIds` and `at`
 * @param {{
 *   rest?: (path: string, init?: RequestInit) => Promise<any>,
 *   restAll?: (path: string) => Promise<any[]>,
 *   writeAs?: typeof writeAs,
 *   complete?: typeof complete,
 *   now?: () => number,
 * }} [deps]
 */
export async function runRecipeDrafts(job, deps = {}) {
  const read = deps.rest ?? rest
  const readAll = deps.restAll ?? restAll
  const write = deps.writeAs ?? writeAs
  const ask = deps.complete ?? complete
  const now = deps.now ?? Date.now
  const started = now()
  const at = Number.isFinite(Date.parse(String(job?.at))) ? new Date(String(job.at)) : new Date(started)
  const counts = { asked: 0, drafted: 0, noAnswer: 0, steppedAside: 0, removed: 0, waiting: 0 }
  /** @type {string[]} */
  const failures = []
  const finish = async () => {
    await recordJobRun(read, 'recipe-drafts', { ok: failures.length === 0, counts, failures }, new Date(now()))
    return { counts, failures }
  }
  const ids = [...new Set((Array.isArray(job?.userIds) ? job.userIds : []).filter(id => typeof id === 'string' && id))].slice(0, MAX_ACCOUNTS)
  if (!ids.length) return finish()
  try {
    const settings = /** @type {{ user_id: string, timezone?: string | null }[]} */ (await read('user_settings?select=user_id,timezone'))
    const byId = new Map((Array.isArray(settings) ? settings : []).map(s => [s.user_id, s]))
    // the digest's moment was in their night, or it would not have named them; checked all the same
    const named = ids.filter(id => recipeNightStarts(byId.get(id) ?? {}, at))
    if (!named.length) return finish()
    // until the v3.35 migration is applied the database refuses every draft: ask the model for none
    if ((await read('rpc/record_kind_allowed', { method: 'POST', body: JSON.stringify({ p_kind: 'recipedraft' }) }).catch(() => null)) !== true) {
      failures.push('the database does not store recipe drafts yet: the v3.35 migration is not applied')
      return finish()
    }
    const peers = await buildPeerMap(read)
    const rows = await readAll('posts?select=id,data,user_id&deleted=is.false&kind=in.(recipe,meal)')
    const drafts = await readAll('posts?select=id,data,user_id&kind=eq.recipedraft')
    const plan = planRecipeDrafts({ rows, drafts, settings: Array.isArray(settings) ? settings : [], peers, named, at })

    // 1. drafts whose recipe was deleted or filled in: removed, as whoever holds them
    for (const d of plan.stale) {
      const id = String(d.data.id)
      const out = await write(String(d.user_id), [purgeTombstone('recipedraft', id, later(new Date(now()).toISOString(), justAfter(d.data?.updatedAt)))])
      if (out.ok && ![...out.rejected, ...out.stale, ...out.gone].includes(id)) counts.removed++
      else failures.push(`${id}: could not be removed${out.ok ? '' : ` (${out.why})`}`)
    }

    // 2. tonight's drafts
    if (!resolveProvider()) return finish()
    let left = plan.groups.reduce((n, g) => n + g.picks.length, 0)
    counts.waiting = plan.groups.reduce((n, g) => n + g.waiting, 0)
    run: for (const group of plan.groups) {
      for (const pick of group.picks) {
        const time = started + JOB_MS - now()
        if (time < START_MIN_MS) {
          failures.push(`no time left in the run: ${left} recipe(s) wait for the next`)
          break run
        }
        left--
        counts.asked++
        const out = await draftRecipe(pick, { read, write, ask, deadline: now() + Math.min(DRAFT_MS, time), now })
        if (out.state === 'failed') {
          failures.push(`${pick.recipe.id}: ${out.why}`)
          // the model is away or refusing: the next hour, or the next night, asks again
          if (out.stop) break run
        } else if (out.state === 'drafted') counts.drafted++
        else if (out.state === 'no answer') counts.noAnswer++
        else counts.steppedAside++
      }
    }
  } catch (e) {
    failures.push(`the job stopped: ${e?.message ?? e}`)
  }
  return finish()
}
