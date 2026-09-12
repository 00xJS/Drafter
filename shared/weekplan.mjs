// "Plan next week", today's meal ideas and the kitchen's history: the proposals
// behind the week-plan sheet, the Today card, Plan my day, the meal assistant,
// the Sunday digest's line and (later) an MCP read tool. Pure and deterministic
// — the same records on the same day propose the same thing, whatever order
// they arrive in — and nothing here writes. There is no stored plan: a proposal
// is worked out from the data each time, so whatever was accepted drops out of
// the next one by itself. A planned meal fills its slot; a planned visit
// suppresses that person.

import { isMineTask, localDate, localMidnightIso } from './domain.mjs'
import { shiftDayKey } from './journal.mjs'
import { plannedVisit, seenStatus } from './people.mjs'
import { outingsAt } from './places.mjs'
import { OPEN, nextUp } from './today.mjs'
import { isDayKey, weekDayKeys, weekKeyOf, weekStartKey } from './weeks.mjs'

const DAY_MS = 86_400_000
/** A recipe cooked this recently is not suggested for next week's dinners. */
const COOLDOWN_DAYS = 14
/** How far back "cooked often" counts, for the week plan and today's ideas alike. */
const FAVOURITE_DAYS = 180
const ALTERNATIVES = 3
/** An event across the dinner hour makes a busy night (local time). */
const DINNER_HOURS = ['17:30', '20:00']
/** Anything on in the evening makes it a worse one for a catch-up. */
const EVENING_HOURS = ['17:30', '22:00']
/** Overdue work is spread so that no day ends up with more than this due. */
const MAX_DUE_PER_DAY = 3
/** The digest's rule: someone never seen is only suggested once they have been in the app a month. */
const NEVER_MIN_AGE_DAYS = 30
const PRIORITY_RANK = { urgent: 3, high: 2, normal: 1, low: 0 }
const CATCH_UP_RANK = { overdue: 0, due: 1, never: 2 }

const IDEAS_PER_SLOT = 4
/** Today's ideas skip anything had in the last week, and anything already planned for the week ahead. */
const IDEA_COOLDOWN_DAYS = 7
const IDEA_AHEAD_DAYS = 7
/** Places you eat at, whether or not a meal was ever logged there. */
const EATING_PLACES = ['restaurant', 'fastfood', 'cafe']
/** What suits a slot beyond having been that meal before: recipe tags, and kinds of place. */
const SLOT_TAGS = { breakfast: ['breakfast', 'brunch'], lunch: ['lunch', 'quick', 'easy', 'light', 'salad', 'sandwich', 'soup'], dinner: ['dinner', 'main'] }
const SLOT_PLACES = { breakfast: ['cafe'], lunch: ['cafe', 'fastfood'], dinner: ['restaurant'] }
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
const liveItems = items => (items ?? []).filter(i => i && typeof i === 'object' && !i.deletedAt)

/** 'YYYY-MM-DDTHH:MM' on the wall clock in `tz` — text that sorts in time order. */
function wallClock(iso, tz) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(ms))
        .map(x => [x.type, x.value]),
    )
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
  } catch {
    const d = new Date(ms)
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

/** Timed events overlapping `day` between two wall-clock times. A work day is working hours, not an engagement. */
function overlapping(events, day, [from, to], tz) {
  const a = `${day}T${from}`
  const b = `${day}T${to}`
  return events
    .filter(ev => {
      if (ev.allDay || ev.work) return false
      const s = wallClock(ev.start, tz)
      const e = wallClock(ev.end, tz)
      return !!s && !!e && s < b && e > a
    })
    .sort((x, y) => cmp(x.start, y.start) || cmp(x.title ?? '', y.title ?? '') || cmp(x.id ?? '', y.id ?? ''))
}

// ---- the kitchen's history ----------------------------------------------------

/**
 * Each recipe's history on the meal plan — the one reading the week plan,
 * today's ideas and the meal assistant all rank by. Per recipe: `count`, times
 * cooked in the last FAVOURITE_DAYS up to today; `total`, times cooked up to
 * today; `lastCooked`, the latest of those; `slots`, the meals it has been; and
 * `last`, the latest meal with it before `before` — which takes in meals
 * already planned, so a recipe on next Tuesday's menu cools down exactly like
 * one eaten last Tuesday. Eaten-out meals are outings, not cooking.
 */
function recipeHistory(meals, todayKey, before) {
  const from = shiftDayKey(todayKey, -FAVOURITE_DAYS)
  const out = new Map()
  for (const m of meals) {
    if (m.out || !m.recipeId || !(m.date < before)) continue
    const s = out.get(m.recipeId) ?? { count: 0, total: 0, last: '', lastCooked: '', slots: new Set() }
    if (m.date <= todayKey) {
      s.total++
      if (m.date >= from) s.count++
      if (m.date > s.lastCooked) s.lastCooked = m.date
      s.slots.add(m.slot)
    }
    if (m.date > s.last) s.last = m.date
    out.set(m.recipeId, s)
  }
  return out
}

/** Nothing with it in the last `days`, and nothing planned with it since. */
const cooledDown = (s, todayKey, days) => !s || s.last < shiftDayKey(todayKey, -days)

/** Every day you went to a place — task outings and meals eaten there, newest first — and the meals it has been. */
function placeHistory(p, tasks, meals, now, tz) {
  // an eaten-out meal on a past day is an outing: the rule the Places tab counts by
  const outings = outingsAt(p.id, tasks, meals, now)
  const eaten = outings.filter(o => o.kind === 'meal')
  const days = outings
    .map(o => (o.kind === 'meal' ? o.meal.date : localDate(o.at, tz)))
    .filter(Boolean)
    .sort()
    .reverse()
  return { days, slots: new Set(eaten.map(o => o.meal.slot)), eatenOut: eaten.length }
}

/** Somewhere you eat: a restaurant, fast food or a café — or anywhere a meal was eaten out. */
const isEatingPlace = (p, h) => EATING_PLACES.includes(p.category) || h.eatenOut > 0

/**
 * What the kitchen knows as of `dayKey`, for anything that shows or sends the
 * numbers the proposals rank by — the meal assistant's options, say: every
 * recipe with how often it was cooked (in six months and in all) and when last,
 * and every place you eat at with its outings (in six months and in all) and
 * when last. Names and tags only: never notes. Sorted by name.
 */
export function mealHistory(items, { dayKey, now = new Date(), tz } = {}) {
  if (!isDayKey(dayKey)) return { recipes: [], places: [] }
  const live = liveItems(items)
  const ofKind = kind => live.filter(i => i.kind === kind)
  const meals = ofKind('meal')
  const tasks = ofKind('task')
  const favouriteFrom = shiftDayKey(dayKey, -FAVOURITE_DAYS)
  const cooked = recipeHistory(meals, dayKey, shiftDayKey(dayKey, 1))
  const byName = (a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)
  const recipes = ofKind('recipe')
    .map(r => {
      const s = cooked.get(r.id)
      return { id: r.id, name: r.name ?? '', tags: [...(r.tags ?? [])], cookCount: s?.count ?? 0, timesCooked: s?.total ?? 0, lastCooked: s?.lastCooked || null }
    })
    .sort(byName)
  const places = ofKind('place')
    .flatMap(p => {
      const h = placeHistory(p, tasks, meals, now, tz)
      if (!isEatingPlace(p, h)) return []
      return [{ id: p.id, name: p.name ?? '', category: p.category, outings: h.days.filter(d => d >= favouriteFrom).length, visits: h.days.length, lastVisit: h.days[0] ?? null }]
    })
    .sort(byName)
  return { recipes, places }
}

// ---- the week ----------------------------------------------------------------

/**
 * The Sunday-start week a plan is for: on Sunday the week beginning today, on
 * any other day the one beginning next Sunday. `prevWeekKey` is the week before
 * it, whose review holds its Top 3 ("Top 3 for next week"). Null for a bad key.
 */
export function targetWeek(todayKey) {
  const start = weekStartKey(todayKey)
  if (!start) return null
  const startKey = start === todayKey ? todayKey : shiftDayKey(start, 7)
  return { startKey, dayKeys: weekDayKeys(startKey), weekKey: weekKeyOf(startKey), prevWeekKey: weekKeyOf(shiftDayKey(startKey, -7)) }
}

function dinnerWhy(s, isNew, todayKey) {
  if (isNew) return 'Something new: saved, never cooked'
  const ago = daysBetween(s.lastCooked, todayKey)
  return s.count > 0 ? `Cooked ${s.count}× in six months · last ${ago} days ago` : `Last cooked ${ago} days ago`
}

/**
 * A recipe for each empty night: the ones cooked most in six months first (and,
 * among those, the longest since), never one cooked in the last fortnight or
 * already planned that week, never twice. One never-cooked recipe a week is
 * offered as something new, on a quiet night — the weekend if one is free. The
 * favourites go to quiet nights; a busy night takes what is left and says why.
 */
function proposeDinners({ days, todayKey, startKey, meals, recipes, busy, skip }) {
  const filled = new Set(meals.filter(m => m.slot === 'dinner').map(m => m.date))
  const nights = days.filter(d => !filled.has(d) && !skip.has(`dinner:${d}`))
  if (nights.length === 0 || recipes.length === 0) return []
  const inWeek = new Set(days)
  const plannedThisWeek = new Set(meals.filter(m => !m.out && m.recipeId && inWeek.has(m.date)).map(m => m.recipeId))
  const everCooked = new Set(meals.filter(m => !m.out && m.recipeId).map(m => m.recipeId))
  // the week being planned, and anything after it, is not history
  const stats = recipeHistory(meals, todayKey, startKey)
  const byName = (a, b) => cmp(a.name ?? '', b.name ?? '') || cmp(a.id, b.id)
  const pool = recipes
    .filter(r => stats.get(r.id)?.total > 0 && !plannedThisWeek.has(r.id) && cooledDown(stats.get(r.id), todayKey, COOLDOWN_DAYS))
    .sort((a, b) => stats.get(b.id).count - stats.get(a.id).count || cmp(stats.get(a.id).lastCooked, stats.get(b.id).lastCooked) || byName(a, b))
  // the newest saved recipe never cooked: most likely the one you meant to try
  const fresh = recipes.filter(r => !everCooked.has(r.id)).sort((a, b) => cmp(b.createdAt ?? '', a.createdAt ?? '') || byName(a, b))[0] ?? null

  const quiet = nights.filter(d => !busy.get(d))
  const assigned = new Map()
  const used = new Set()
  const newNight = fresh ? ([days[6], days[0]].find(d => quiet.includes(d)) ?? quiet[0]) : undefined
  if (fresh && newNight) {
    assigned.set(newNight, fresh)
    used.add(fresh.id)
  }
  let next = 0
  for (const d of [...quiet, ...nights.filter(n => busy.get(n))]) {
    if (assigned.has(d)) continue
    if (next >= pool.length) break
    assigned.set(d, pool[next])
    used.add(pool[next].id)
    next++
  }
  const spare = pool.filter(r => !used.has(r.id))

  const out = []
  for (const d of nights) {
    const r = assigned.get(d)
    if (!r) continue
    // each night's Swap cycles a different few of the spares where there are enough
    const offset = out.length * ALTERNATIVES
    const alternatives = Array.from({ length: Math.min(ALTERNATIVES, spare.length) }, (_, j) => spare[(offset + j) % spare.length].id)
    const isNew = r === fresh
    out.push({ key: `dinner:${d}`, date: d, recipeId: r.id, title: r.name, why: dinnerWhy(stats.get(r.id), isNew, todayKey), alternatives, busy: busy.get(d) ?? null, isNew })
  }
  return out
}

/**
 * Anyone due or overdue a catch-up with no visit already planned, plus people
 * never seen who have been in the app a month (the digest's rule). Most overdue
 * first. Each goes on the Saturday while it is free, then on the quietest
 * evening, earliest first.
 */
function proposePeople({ days, people, tasks, now, eveningLoad, dueCount, skip }) {
  const nowMs = now.getTime()
  const due = []
  for (const p of people) {
    if (skip.has(`person:${p.id}`) || plannedVisit(p.id, tasks)) continue
    const s = seenStatus(p, tasks, now)
    if (!(s.status in CATCH_UP_RANK)) continue
    if (s.status === 'never') {
      const created = Date.parse(p.createdAt ?? '')
      if (!Number.isFinite(created) || nowMs - created < NEVER_MIN_AGE_DAYS * DAY_MS) continue
    }
    due.push({ p, s })
  }
  due.sort(
    (a, b) =>
      CATCH_UP_RANK[a.s.status] - CATCH_UP_RANK[b.s.status] || (b.s.daysSince ?? 0) - (a.s.daysSince ?? 0) || cmp(a.p.name ?? '', b.p.name ?? '') || cmp(a.p.id, b.p.id),
  )
  const booked = new Map(days.map(d => [d, eveningLoad.get(d) ?? 0]))
  const saturday = days[6]
  return due.map(({ p, s }) => {
    const dueDay = booked.get(saturday) === 0 ? saturday : days.reduce((best, d) => (booked.get(d) < booked.get(best) ? d : best), days[0])
    booked.set(dueDay, booked.get(dueDay) + 1)
    dueCount.set(dueDay, (dueCount.get(dueDay) ?? 0) + 1)
    return { key: `person:${p.id}`, personId: p.id, title: `Catch up with ${p.name}`, dueDay, why: s.reason }
  })
}

/**
 * Your overdue work, spread over the week: urgent and high first, then the
 * longest overdue, each to the least loaded day — and no day past three due,
 * counting what is already due there. What does not fit is left where it is.
 */
function proposeResched({ days, todayKey, tasks, userId, dueCount, dayOf, skip }) {
  const overdue = tasks
    // a bill falls due on its own day: it is a heads-up, never something to move
    .filter(t => OPEN.includes(t.status) && t.dueAt && !t.bill && isMineTask(t, userId) && !skip.has(`resched:${t.id}`))
    .map(t => ({ t, day: dayOf(t.dueAt) }))
    .filter(x => x.day && x.day < todayKey)
    .sort((a, b) => (PRIORITY_RANK[b.t.priority] ?? 1) - (PRIORITY_RANK[a.t.priority] ?? 1) || cmp(a.day, b.day) || cmp(a.t.dueAt, b.t.dueAt) || cmp(a.t.id, b.t.id))
  const out = []
  for (const { t, day } of overdue) {
    const room = days.filter(d => dueCount.get(d) < MAX_DUE_PER_DAY)
    if (room.length === 0) break
    const toDay = room.reduce((best, d) => (dueCount.get(d) < dueCount.get(best) ? d : best))
    dueCount.set(toDay, dueCount.get(toDay) + 1)
    const late = daysBetween(day, todayKey)
    const urgent = t.priority === 'urgent' || t.priority === 'high' ? ` · ${t.priority}` : ''
    out.push({ key: `resched:${t.id}`, taskId: t.id, title: t.title || 'Untitled task', fromDue: t.dueAt, toDay, why: `Overdue ${late} day${late === 1 ? '' : 's'}${urgent}` })
  }
  return out
}

/**
 * The week ahead, proposed from the records: dinners for the empty nights,
 * catch-ups, overdue work to spread, bills falling due, and a Top 3 while last
 * week's review has none. `items` is every record the reader can see, of any
 * kind; `events` adds occurrences from subscribed calendars (the app has them,
 * the digest does not). Rows whose key is in `dismissed` are left out. Null for
 * a bad `todayKey`.
 */
export function proposeWeek(items, { todayKey, tz, userId = null, dismissed = [], now = new Date(), events = [] } = {}) {
  const week = targetWeek(todayKey)
  if (!week) return null
  const skip = new Set(dismissed ?? [])
  const live = liveItems(items)
  const ofKind = kind => live.filter(i => i.kind === kind)
  const tasks = ofKind('task')
  const meals = ofKind('meal')
  const reviews = ofKind('review')
  const days = week.dayKeys
  const inWeek = new Set(days)
  const dayOf = iso => (typeof iso === 'string' && DAY_KEY_RE.test(iso) ? iso : localDate(iso, tz))
  // our own entries are items already; a feed's copy of one (localId) would count it twice
  const calendar = [...ofKind('event'), ...(events ?? []).filter(ev => ev && !ev.localId)]
  const busy = new Map(
    days.map(d => {
      const ev = overlapping(calendar, d, DINNER_HOURS, tz)[0]
      return [d, ev ? ev.title || 'Something on' : null]
    }),
  )
  const eveningLoad = new Map(days.map(d => [d, overlapping(calendar, d, EVENING_HOURS, tz).length]))
  const dueCount = new Map(days.map(d => [d, 0]))
  for (const t of tasks) {
    if (!OPEN.includes(t.status) || !t.dueAt || !isMineTask(t, userId)) continue
    const d = dayOf(t.dueAt)
    if (dueCount.has(d)) dueCount.set(d, dueCount.get(d) + 1)
  }

  const dinners = proposeDinners({ days, todayKey, startKey: week.startKey, meals, recipes: ofKind('recipe'), busy, skip })
  const people = proposePeople({ days, people: ofKind('person'), tasks, now, eveningLoad, dueCount, skip })
  const overdue = proposeResched({ days, todayKey, tasks, userId, dueCount, dayOf, skip })

  const bills = tasks
    .filter(t => t.bill && OPEN.includes(t.status) && t.dueAt && inWeek.has(dayOf(t.dueAt)) && !skip.has(`bill:${t.id}`))
    .map(t => ({
      key: `bill:${t.id}`,
      taskId: t.id,
      title: t.title || t.bill.payee || 'Bill',
      dueDay: dayOf(t.dueAt),
      amount: typeof t.estimateCost === 'number' && Number.isFinite(t.estimateCost) ? t.estimateCost : null,
      autopay: !!t.bill.autopay,
    }))
    .sort((a, b) => cmp(a.dueDay, b.dueDay) || cmp(a.title, b.title) || cmp(a.taskId, b.taskId))

  // Only while last week's review — the one Today reads as "This week's 3" and
  // Review writes as "Top 3 for next week" — has none: never over the user's own.
  const review = reviews.find(r => r.period === 'week' && r.key === week.prevWeekKey && (!userId || r.ownerId == null || r.ownerId === userId))
  const hasTop = (review?.top ?? []).some(line => String(line ?? '').trim())
  const dueInWeek = tasks
    .filter(t => OPEN.includes(t.status) && !t.bill && String(t.title ?? '').trim() && isMineTask(t, userId) && t.dueAt && inWeek.has(dayOf(t.dueAt)))
    // Next up keeps ties in the order it was given: sorting first keeps the proposal deterministic
    .sort((a, b) => cmp(a.id, b.id))
  const top3 = hasTop
    ? []
    : nextUp(dueInWeek, ofKind('project'), 3, now)
        .map((n, i) => ({ key: `top:${i}`, title: n.task.title.trim(), taskId: n.task.id }))
        .filter(x => !skip.has(x.key))

  return { week, dinners, people, overdue, bills, top3 }
}

/** "4 dinners to fill · 2 catch-ups · 3 bills due", or null when there is nothing to plan. */
export function weekPlanSummary(plan) {
  if (!plan) return null
  const n = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`
  const parts = []
  if (plan.dinners.length) parts.push(`${n(plan.dinners.length, 'dinner')} to fill`)
  if (plan.people.length) parts.push(n(plan.people.length, 'catch-up'))
  if (plan.overdue.length) parts.push(`${plan.overdue.length} overdue to move`)
  if (plan.bills.length) parts.push(`${n(plan.bills.length, 'bill')} due`)
  if (plan.top3.length) parts.push('a Top 3 to pick')
  return parts.length ? parts.join(' · ') : null
}

/**
 * The task an accepted catch-up becomes: a visit with them, due all day on its
 * day (local midnight in this runtime's zone), so it reads as a plan on the
 * People card — and, open, suppresses them from the next proposal.
 */
export function catchUpTask(item, { id, now = new Date() }) {
  const stamp = now.toISOString()
  return {
    kind: 'task',
    id,
    title: item.title,
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: localMidnightIso(item.dueDay) ?? undefined,
    tags: ['visit'],
    peopleIds: [item.personId],
    createdAt: stamp,
    updatedAt: stamp,
  }
}

// ---- today's meal ideas -------------------------------------------------------

/** "4 days", "5 weeks", "3 months". */
function span(days) {
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`
  if (days < 60) return `${Math.round(days / 7)} weeks`
  return `${Math.round(days / 30)} months`
}

/** "3 May", with the year only when it is not this one. */
function dayMonth(key, todayKey) {
  const [y, m, d] = key.split('-').map(Number)
  return `${d} ${MONTH_NAMES[m - 1]}${key.slice(0, 4) === todayKey.slice(0, 4) ? '' : ` ${y}`}`
}

function ideaWhy(c, how, dayKey) {
  if (how === 'popular') return c.kind === 'recipe' ? `Cooked ${c.count}× in six months` : `Been ${c.count}× in six months`
  return c.kind === 'recipe' ? `Not cooked in ${span(daysBetween(c.last, dayKey))}` : `Haven't been since ${dayMonth(c.last, dayKey)}`
}

/**
 * Ideas for today's empty meals, for the Today card and Plan my day. For each
 * slot with nothing planned — a slot with any meal, cooked, eaten out, or out
 * with no place, is not missing — about four ideas, alternating between what is
 * popular (cooked or eaten at most in six months) and old favourites (had twice
 * or more) not had for longest. Recipes and places you eat at compete alike.
 * Nothing had in the last week or planned for the week ahead, never the same
 * idea for two slots on one day, and never anything not yet tried — there is
 * nothing to go on. Lunch leans to cafés, fast food and recipes tagged for it,
 * dinner to restaurants, and whatever has been that meal before suits it; with
 * no such signal the slots are treated alike.
 */
export function mealIdeasFor(items, { dayKey, slots = ['lunch', 'dinner'], now = new Date(), dismissed = [], tz } = {}) {
  if (!isDayKey(dayKey)) return []
  const live = liveItems(items)
  const ofKind = kind => live.filter(i => i.kind === kind)
  const meals = ofKind('meal')
  const tasks = ofKind('task')
  const skip = new Set(dismissed ?? [])
  const ahead = shiftDayKey(dayKey, IDEA_AHEAD_DAYS)
  const coolFrom = shiftDayKey(dayKey, -IDEA_COOLDOWN_DAYS)
  const favouriteFrom = shiftDayKey(dayKey, -FAVOURITE_DAYS)

  const candidates = []
  // a meal already on the menu for the week ahead cools a recipe down like one just eaten
  const cooked = recipeHistory(meals, dayKey, shiftDayKey(ahead, 1))
  for (const r of ofKind('recipe')) {
    const s = cooked.get(r.id)
    if (!s || s.total === 0 || !cooledDown(s, dayKey, IDEA_COOLDOWN_DAYS)) continue
    candidates.push({ kind: 'recipe', id: r.id, title: r.name ?? '', count: s.count, total: s.total, last: s.lastCooked, slots: s.slots, tags: (r.tags ?? []).map(t => String(t).toLowerCase()), category: null })
  }
  for (const p of ofKind('place')) {
    const h = placeHistory(p, tasks, meals, now, tz)
    if (h.days.length === 0 || !isEatingPlace(p, h)) continue
    const plannedSoon = meals.some(m => m.out && m.placeId === p.id && m.date >= dayKey && m.date <= ahead)
    if (plannedSoon || h.days[0] >= coolFrom) continue
    candidates.push({ kind: 'place', id: p.id, title: p.name ?? '', count: h.days.filter(d => d >= favouriteFrom).length, total: h.days.length, last: h.days[0], slots: h.slots, tags: [], category: p.category })
  }

  const fits = (c, slot) => c.slots.has(slot) || (c.kind === 'recipe' ? c.tags.some(t => (SLOT_TAGS[slot] ?? []).includes(t)) : (SLOT_PLACES[slot] ?? []).includes(c.category))
  const tie = (a, b) => cmp(a.title, b.title) || cmp(a.kind, b.kind) || cmp(a.id, b.id)
  const planned = new Set(meals.filter(m => m.date === dayKey).map(m => m.slot))
  const used = new Set()
  return slots.map(slot => {
    if (planned.has(slot)) return { slot, missing: false, ideas: [] }
    const keyOf = c => `idea:${dayKey}:${slot}:${c.kind}:${c.id}`
    const open = candidates.filter(c => !used.has(`${c.kind}:${c.id}`) && !skip.has(keyOf(c)))
    const suits = (a, b) => Number(fits(b, slot)) - Number(fits(a, slot))
    const popular = open.filter(c => c.count > 0).sort((a, b) => suits(a, b) || b.count - a.count || tie(a, b))
    const longAgo = open.filter(c => c.total >= 2).sort((a, b) => suits(a, b) || cmp(a.last, b.last) || tie(a, b))
    const lists = [
      [popular, 'popular'],
      [longAgo, 'longAgo'],
    ]
    const at = [0, 0]
    const chosen = new Set()
    const ideas = []
    for (let turn = 0; ideas.length < IDEAS_PER_SLOT && (at[0] < popular.length || at[1] < longAgo.length); turn = 1 - turn) {
      const [list, how] = lists[turn]
      while (at[turn] < list.length && chosen.has(list[at[turn]])) at[turn]++
      if (at[turn] >= list.length) continue
      const c = list[at[turn]++]
      chosen.add(c)
      used.add(`${c.kind}:${c.id}`)
      ideas.push({ key: keyOf(c), kind: c.kind, id: c.id, title: c.title, why: ideaWhy(c, how, dayKey) })
    }
    return { slot, missing: true, ideas }
  })
}
