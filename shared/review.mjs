// What a review period holds: what got done, what slipped, who you saw and
// which habits you kept. Home → Week (src/review.ts buildReview, and the ✨
// summary's habit line) and Sunday's automatic draft (netlify/functions/digest.mjs)
// both read these lists, so the draft never names a task, a person or a habit
// the Week segment does not, nor counts one differently. Dependency-free ESM.

import { shiftDayKey } from './journal.mjs'
import { visitDays, visitsFor } from './people.mjs'
import { OPEN } from './today.mjs'
import { isDayKey } from './weeks.mjs'

const ms = d => (d instanceof Date ? d.getTime() : Number(d))

/** A logged get-together, not a piece of work: counted separately everywhere. */
export const isVisit = t => (t?.tags ?? []).includes('visit')

/** Whether an instant falls inside [start, end). Dates or epoch ms; a bad instant never does. */
export function inRange(iso, start, end) {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) && t >= ms(start) && t < ms(end)
}

/**
 * The period's task lists. `done`: finished inside it, newest first, visits
 * left out. `visitsDone`: the visits logged inside it. `slipped`: still open,
 * due inside it, and that time has passed. `range` is { start, end }, end
 * exclusive. A bill is a task and counts like one; a wishlist item is not open.
 */
export function reviewLists(tasks, range, now = new Date()) {
  const nowMs = ms(now)
  const doneAll = (tasks ?? [])
    .filter(t => t.status === 'done' && inRange(t.completedAt, range.start, range.end))
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
  return {
    done: doneAll.filter(t => !isVisit(t)),
    visitsDone: doneAll.filter(isVisit),
    slipped: (tasks ?? []).filter(t => OPEN.includes(t.status) && inRange(t.dueAt, range.start, range.end) && Date.parse(t.dueAt) < nowMs),
  }
}

/**
 * Who you saw in the period, most days first: each person with their visits
 * in it and the days those fell on. `seen` is what seenTasks gives (the tasks,
 * and your own past events as the visits they amount to); `dayKeyOf` turns an
 * instant into YYYY-MM-DD in the reader's zone.
 */
export function peopleSeen(people, seen, range, dayKeyOf) {
  return (people ?? [])
    .map(p => {
      const visits = visitsFor(p.id, seen).filter(v => inRange(v.at, range.start, range.end))
      return { person: p, visits: visits.map(v => v.task), days: visitDays(visits, dayKeyOf).length }
    })
    .filter(x => x.visits.length > 0)
    .sort((a, b) => b.days - a.days || b.visits.length - a.visits.length)
}

/** A YYYY-MM-DD key's weekday, 0 = Sunday: the date's own, whatever the zone. */
const weekdayOf = key => new Date(`${key}T12:00:00Z`).getUTCDay()

/** Due on that day? No days (or an empty list) means every day. */
const dueOn = (habit, key) => !habit?.days?.length || habit.days.includes(weekdayOf(key))

/**
 * A habit's streak as it stood on `lastKey`: the due days up to it, in a row,
 * that are done. A day it is not due on is skipped, not missed, so a weekday
 * habit's streak survives the weekend. `lastKey` left unticked waits rather
 * than breaks the run only while it is `todayKey`, the day still going: Today's
 * 🔥 n is this with both today, and a review counts the streak its period
 * ended on.
 */
export function habitStreak(habit, lastKey, todayKey = lastKey) {
  if (!isDayKey(lastKey)) return 0
  const done = new Set(habit?.done ?? [])
  let streak = 0
  let key = lastKey
  for (let i = 0; i < 3660; i++, key = shiftDayKey(key, -1)) {
    if (!dueOn(habit, key)) continue
    if (done.has(key)) streak++
    else if (i > 0 || key !== todayKey) break
  }
  return streak
}

/**
 * Every habit's kept and missed days in the period, and the streak it ended
 * on, with the totals. Only due days count, and only up to today, so a week
 * still going reads "3/3 so far" rather than "3/7"; days before a habit
 * existed are not owed, and an archived or deleted habit is not counted at
 * all. A habit with nothing due in the period is left out. `range` is
 * { start, end }, end exclusive; `dayKeyOf` turns an instant into YYYY-MM-DD
 * in the reader's zone, as for peopleSeen: the period's edges, today and each
 * habit's first day are all read through it.
 */
export function habitsKept(habits, range, now, dayKeyOf) {
  const dayOf = at => dayKeyOf(new Date(ms(at)).toISOString())
  const startKey = dayOf(range.start)
  const lastInRange = shiftDayKey(dayOf(range.end), -1)
  const todayKey = dayOf(now)
  const lastKey = lastInRange < todayKey ? lastInRange : todayKey
  const valid = [startKey, lastInRange, todayKey].every(isDayKey)
  const rows = (valid ? (habits ?? []) : [])
    .filter(h => h && !h.deletedAt && !h.archivedAt)
    .map(habit => {
      // createdAt is an instant; the habit's first day is that instant's day for the reader
      const born = Date.parse(habit.createdAt ?? '')
      const bornKey = Number.isFinite(born) ? dayOf(born) : startKey
      const from = isDayKey(bornKey) && bornKey > startKey ? bornKey : startKey
      const done = new Set(habit.done ?? [])
      let kept = 0
      let due = 0
      for (let key = from; key <= lastKey; key = shiftDayKey(key, 1)) {
        if (!dueOn(habit, key)) continue
        due++
        if (done.has(key)) kept++
      }
      return { habit, done: kept, due, missed: due - kept, streak: habitStreak(habit, lastKey, todayKey) }
    })
    .filter(r => r.due > 0)
  const done = rows.reduce((s, r) => s + r.done, 0)
  const due = rows.reduce((s, r) => s + r.due, 0)
  return { rows, done, due, pct: due ? Math.round((done / due) * 100) : 0 }
}

/**
 * What the model is told about habits: one compact line, so it can weigh them
 * without a tally per day, or nothing when nothing was due.
 * "77% consistent (10/13 kept, 3 missed): Read 6/7 (1 missed, streak 4) · Gym 3/3 (streak 5)"
 */
export function habitLines(kept) {
  if (!kept?.due) return []
  const rows = kept.rows.map(r => {
    const notes = [r.missed ? `${r.missed} missed` : '', r.streak ? `streak ${r.streak}` : ''].filter(Boolean)
    return `${r.habit.name} ${r.done}/${r.due}${notes.length ? ` (${notes.join(', ')})` : ''}`
  })
  return [`${kept.pct}% consistent (${kept.done}/${kept.due} kept, ${kept.due - kept.done} missed): ${rows.join(' · ')}`]
}
