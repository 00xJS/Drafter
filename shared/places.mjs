// Place rules shared by the web app and the MCP server. Dependency-free ESM.

/**
 * The kinds of place, in the order the app offers them. One list for the app
 * and the MCP server: a category added here is one an assistant can save and
 * filter by too, instead of being refused as invalid.
 */
export const PLACE_CATEGORIES = ['restaurant', 'fastfood', 'cafe', 'bar', 'outdoors', 'venue', 'shop', 'home', 'other']

/** How each category reads: the app's chips and pickers, and the MCP tool descriptions. */
export const PLACE_CATEGORY_META = {
  restaurant: { label: 'Restaurant', emoji: '🍽️' },
  fastfood: { label: 'Fast food', emoji: '🍔' },
  cafe: { label: 'Café', emoji: '☕' },
  bar: { label: 'Bar', emoji: '🍸' },
  outdoors: { label: 'Outdoors', emoji: '🌳' },
  venue: { label: 'Venue', emoji: '🎭' },
  shop: { label: 'Shop', emoji: '🛍️' },
  home: { label: 'Home', emoji: '🏠' },
  other: { label: 'Other', emoji: '📍' },
}

/** Lower-case, no diacritics or punctuation, single spaces — so "NOPI, 21 Warwick St" and "Nopi" can meet. */
export function normalisePlaceText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The most other names a place keeps. */
export const MAX_PLACE_ALIASES = 12
const ALIAS_MAX = 80
const ADDRESS_MAX = 200

/** One line with single spaces, cut to `max` characters. */
const oneLine = (s, max) => String(s).replace(/\s+/g, ' ').trim().slice(0, max).trim()

/** A place's address as it is kept: one line, or undefined when there is none. */
export function tidyPlaceAddress(v) {
  return typeof v === 'string' ? oneLine(v, ADDRESS_MAX) || undefined : undefined
}

/**
 * A place's other names ("Pret" for Pret A Manger) as the editor, the
 * sanitizer and the MCP server all keep them: each on one line, each once
 * however it is capitalised, never the place's own name over again, and at
 * most MAX_PLACE_ALIASES. Undefined when none are left, so a place without
 * any carries no empty list.
 */
export function tidyPlaceAliases(v, name) {
  if (!Array.isArray(v)) return undefined
  const seen = new Set([oneLine(name ?? '', ALIAS_MAX).toLowerCase()])
  const out = []
  for (const raw of v) {
    if (typeof raw !== 'string') continue
    const alias = oneLine(raw, ALIAS_MAX)
    if (!alias || seen.has(alias.toLowerCase())) continue
    seen.add(alias.toLowerCase())
    out.push(alias)
    if (out.length === MAX_PLACE_ALIASES) break
  }
  return out.length ? out : undefined
}

/**
 * The shortest name, other name or address that is looked for inside a
 * longer location. One letter ("Q") is too little to go on there: it links
 * only a location that is exactly it.
 */
const MIN_TERM = 2

/** What a place goes by, normalised: its name, then its other names, then its address. */
function placeTerms(p) {
  const aliases = Array.isArray(p.aliases) ? p.aliases : []
  return [p.name, ...aliases, p.address].map(normalisePlaceText).filter(Boolean)
}

/**
 * Find the saved place a free-text location refers to: an event's location,
 * a question, a place an assistant names. A place goes by its name, its other
 * names and its address, and the text finds it by any of them.
 *
 * The whole text being one of them wins first, a place's own name before
 * anyone's other name or address. Then one of them as a run of whole words
 * inside the text ("Nopi" in "NOPI, 21 Warwick St", an address in "Nopi, 21
 * Warwick St, London"), never part of a word, so an other name "Bo" is not
 * found in "Bob's Diner". Never fuzzier than that — a wrong match would log
 * an outing somewhere you never went.
 */
export function matchPlace(text, places) {
  const needle = normalisePlaceText(text)
  if (!needle) return null
  const list = (places ?? []).filter(p => p && !p.deletedAt && p.name)
  const exact = list.find(p => normalisePlaceText(p.name) === needle) ?? list.find(p => placeTerms(p).includes(needle))
  if (exact) return exact
  // a location string usually opens with the venue: the earliest-named place
  // wins, and only between places starting at the same word does the longer win
  const padded = ` ${needle} `
  const contained = list
    .flatMap(p => placeTerms(p).map(n => ({ p, n })))
    .filter(({ n }) => n.length >= MIN_TERM)
    .map(x => ({ ...x, at: padded.indexOf(` ${x.n} `) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at || b.n.length - a.n.length)
  return contained[0]?.p ?? null
}

const DAY_MS = 86_400_000

/**
 * Midday UTC for a date-only key. A meal records a day, not an instant, and
 * midday UTC lands on that same calendar day in every zone from UTC-12 to
 * UTC+11, which midnight would not. East of UTC+11 (all of New Zealand, Tonga,
 * Kiribati) it is already the next day, so a count that files outings by month
 * or year re-dates a meal to local midday on its own date first
 * (placeYearReport in src/places.ts).
 */
const middayOf = dateKey => `${dateKey}T12:00:00.000Z`

/**
 * Everything that counts as having been to this place, newest first.
 *
 * Two things count, and they are the same event seen from different tabs: a
 * done task carrying the place, and a meal you marked as eaten out there. A
 * takeaway IS an outing — counting it is what lets "how often do we eat there"
 * and "been a while" agree instead of drifting apart.
 *
 * Open tasks and tombstones never count, and neither does a meal in the
 * FUTURE: next Friday's booking is a plan, not a visit, so it must not reset a
 * cadence or inflate a count. Meals are optional so every existing caller keeps
 * working unchanged.
 */
export function outingsAt(placeId, tasks, meals = [], now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const fromTasks = (tasks ?? [])
    .filter(t => t && !t.deletedAt && t.status === 'done' && t.completedAt && t.placeId === placeId)
    .map(t => ({ kind: 'task', task: t, at: t.completedAt }))
  const fromMeals = (meals ?? [])
    .filter(m => m && !m.deletedAt && m.out === true && m.placeId === placeId && m.date)
    .map(m => ({ kind: 'meal', meal: m, at: middayOf(m.date) }))
    .filter(v => Date.parse(v.at) <= nowMs)
  return [...fromTasks, ...fromMeals].sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * Cadence status for one place. Opt-in per place: there is deliberately no
 * default cadence for places (people fall back to 90 days) — a restaurant you
 * never set a rhythm for must never read as due or overdue on Today or in the
 * digest. Same 1× due / 1.5× overdue thresholds as people once a cadence is set.
 */
export function placeCadenceStatus(place, tasks, now = new Date(), meals = []) {
  const cadence = Number(place?.cadenceDays)
  if (!Number.isFinite(cadence) || cadence <= 0) return { status: 'none', reason: '' }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const lastAt = outingsAt(place.id, tasks, meals, now)[0]?.at
  if (!lastAt) {
    return { status: 'never', reason: `No outings yet — you aimed for every ${cadence} days`, cadenceDays: cadence }
  }
  const daysSince = Math.floor((nowMs - Date.parse(lastAt)) / DAY_MS)
  let status
  let reason
  if (daysSince > cadence * 1.5) {
    status = 'overdue'
    reason = `Last went ${daysSince} days ago — you aimed for every ${cadence} days`
  } else if (daysSince > cadence) {
    status = 'due'
    reason = `It's been ${daysSince} days; you aimed for every ${cadence} days`
  } else {
    status = 'ok'
    reason = daysSince <= 0 ? 'Went today' : `Last went ${daysSince} day${daysSince === 1 ? '' : 's'} ago`
  }
  return { status, reason, lastAt, daysSince, cadenceDays: cadence }
}
