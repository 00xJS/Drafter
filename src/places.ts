import { Person, Place, Task } from './types'
import { Visit, visitSummary, visitsFor } from './people'
import { PlaceCadenceState, PlaceCadenceStatus, matchPlace as sharedMatchPlace, normalisePlaceText, placeCadenceStatus, outingsAt as sharedOutingsAt } from '../shared/places.mjs'

export { normalisePlaceText, placeCadenceStatus }
export type { PlaceCadenceState, PlaceCadenceStatus }

/** The saved place a free-text location (calendar LOCATION, a note) refers to, or undefined. */
export function matchPlace(text: string | null | undefined, places: Place[]): Place | undefined {
  return sharedMatchPlace(text, places) ?? undefined
}

/** How long a loved place can go unvisited before it counts as lapsed. */
export const LAPSED_AFTER_DAYS = 120

/** Places with at least two outings in the last year, most visited first. */
export function favourites(places: Place[], tasks: Task[], people: Person[] = [], now: Date = new Date()): PlaceStats[] {
  return places
    .map(p => placeStats(p, tasks, people, now))
    .filter(s => s.count365 >= 2)
    .sort((a, b) => b.count365 - a.count365 || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
}

/**
 * Places you loved and drifted from: two or more outings ever, and longer since
 * the last one than both LAPSED_AFTER_DAYS and twice your usual gap there.
 */
export function lapsed(places: Place[], tasks: Task[], people: Person[] = [], now: Date = new Date()): PlaceStats[] {
  return places
    .map(p => placeStats(p, tasks, people, now))
    .filter(s => s.visits.length >= 2 && s.daysSince !== undefined && s.daysSince > Math.max(LAPSED_AFTER_DAYS, s.avgGapDays ? 2 * s.avgGapDays : 0))
    .sort((a, b) => b.visits.length - a.visits.length)
}

/** Done tasks at a place, newest first. Open tasks and tombstones are ignored (rule in shared/places.mjs). */
export function outingsAt(placeId: string, tasks: Task[]): Visit[] {
  return sharedOutingsAt(placeId, tasks) as Visit[]
}

export interface Companion {
  person: Person
  count: number
}

export interface PlaceStats {
  place: Place
  visits: Visit[]
  lastAt?: string
  daysSince?: number
  count365: number
  avgGapDays?: number
  weekly: number[]
  companions: Companion[]
  /** One-line list reason; when the place is due/overdue it ends with the rhythm you set. */
  reason: string
  /** 'none' unless the place has a cadence — a place without one is never due. */
  status: PlaceCadenceState
}

function placeReason(lastAt: string | undefined, daysSince: number | undefined, count365: number): string {
  if (!lastAt) return 'No outings yet'
  const ago =
    daysSince === undefined
      ? 'recently'
      : daysSince <= 0
        ? 'today'
        : daysSince === 1
          ? 'yesterday'
          : `${daysSince} days ago`
  return `Last went ${ago} · ${count365} time${count365 === 1 ? '' : 's'} this year`
}

export function companionsAt(placeId: string, people: Person[], tasks: Task[]): Companion[] {
  const counts = new Map<string, number>()
  for (const v of outingsAt(placeId, tasks)) {
    for (const id of v.task.peopleIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([id, count]) => {
      const person = people.find(p => p.id === id)
      return person ? { person, count } : null
    })
    .filter((c): c is Companion => !!c)
    .sort((a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name))
    .slice(0, 5)
}

export function placeStats(place: Place, tasks: Task[], people: Person[], now: Date = new Date()): PlaceStats {
  const visits = outingsAt(place.id, tasks)
  const summary = visitSummary(visits, now)
  const cadence = placeCadenceStatus(place, tasks, now)
  const base = placeReason(summary.lastAt, summary.daysSince, summary.count365)
  const nagging = cadence.status === 'due' || cadence.status === 'overdue'
  return {
    place,
    visits,
    lastAt: summary.lastAt,
    daysSince: summary.daysSince,
    count365: summary.count365,
    avgGapDays: summary.avgGapDays,
    weekly: summary.weekly,
    companions: companionsAt(place.id, people, tasks),
    reason: nagging ? `${base} — you aimed for every ${cadence.cadenceDays} days` : base,
    status: cadence.status,
  }
}

export interface PlaceWithPerson {
  place: Place
  count: number
  lastAt: string
}

/** Places logged on visits with this person, by outing count. */
export function placesWith(personId: string, places: Place[], tasks: Task[]): PlaceWithPerson[] {
  const byPlace = new Map<string, { count: number; lastAt: string }>()
  for (const v of visitsFor(personId, tasks)) {
    const pid = v.task.placeId
    if (!pid) continue
    const cur = byPlace.get(pid)
    if (!cur) byPlace.set(pid, { count: 1, lastAt: v.at })
    else {
      cur.count++
      if (v.at.localeCompare(cur.lastAt) > 0) cur.lastAt = v.at
    }
  }
  return [...byPlace.entries()]
    .map(([id, stats]) => {
      const place = places.find(p => p.id === id)
      return place ? { place, ...stats } : null
    })
    .filter((x): x is PlaceWithPerson => !!x)
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
}
