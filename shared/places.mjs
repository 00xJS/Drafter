// Place rules shared by the web app and the MCP server. Dependency-free ESM.

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

/**
 * Find the saved place a free-text location refers to. Exact name (or alias)
 * first; then a place whose whole name appears as a word sequence inside the
 * text ("Nopi" in "NOPI, 21 Warwick St"). Never fuzzier than that — a wrong
 * match would log an outing somewhere you never went.
 */
export function matchPlace(text, places) {
  const needle = normalisePlaceText(text)
  if (!needle) return null
  const list = (places ?? []).filter(p => p && !p.deletedAt && p.name)
  const exact = list.find(p => normalisePlaceText(p.name) === needle || (p.aliases ?? []).some(a => normalisePlaceText(a) === needle))
  if (exact) return exact
  // a location string usually opens with the venue: the earliest-named place
  // wins, and only between places starting at the same word does the longer win
  const padded = ` ${needle} `
  const contained = list
    .map(p => ({ p, n: normalisePlaceText(p.name) }))
    .filter(({ n }) => n.length >= 3)
    .map(x => ({ ...x, at: padded.indexOf(` ${x.n} `) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at || b.n.length - a.n.length)
  return contained[0]?.p ?? null
}

const DAY_MS = 86_400_000

/**
 * Midday UTC for a date-only key. A meal records a day, not an instant, and
 * midday lands on that same calendar day in every zone from UTC-11 to UTC+12 —
 * which midnight would not.
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
