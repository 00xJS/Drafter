import { Person, Place, Task } from './types'
import { Visit, visitSummary, visitsFor } from './people'

/** Done tasks at a place, newest first. Open tasks and tombstones are ignored. */
export function outingsAt(placeId: string, tasks: Task[]): Visit[] {
  return tasks
    .filter(t => !t.deletedAt && t.status === 'done' && !!t.completedAt && t.placeId === placeId)
    .map(t => ({ task: t, at: t.completedAt! }))
    .sort((a, b) => b.at.localeCompare(a.at))
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
  /** One-line list reason. */
  reason: string
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
  return {
    place,
    visits,
    lastAt: summary.lastAt,
    daysSince: summary.daysSince,
    count365: summary.count365,
    avgGapDays: summary.avgGapDays,
    weekly: summary.weekly,
    companions: companionsAt(place.id, people, tasks),
    reason: placeReason(summary.lastAt, summary.daysSince, summary.count365),
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
