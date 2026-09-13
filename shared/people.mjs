// People cadence / occasions shared by the web app, digest, and MCP.
// Dependency-free ESM.

export const DEFAULT_CADENCE_DAYS = 90
export const DAY_MS = 86_400_000

const OPEN = ['todo', 'doing', 'blocked']

/** Completed tasks attached to this person, newest first. */
export function visitsFor(personId, tasks) {
  return (tasks ?? [])
    .filter(t => t.status === 'done' && t.completedAt && (t.peopleIds ?? []).includes(personId))
    .map(t => ({ task: t, at: t.completedAt }))
    .sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * Your own calendar entries that have happened with people on them, as the done
 * visit task "Who was there?" logs for a subscribed calendar's event: titled as
 * the event and dated at its start (midday on an all-day one), so visitsFor and
 * everything built on it counts them the same way. A work day is never a visit,
 * and nothing counts before that time has come. Each keeps its entry's id, so a
 * visit can open the entry it came from.
 */
export function eventVisits(entries, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const out = []
  for (const e of entries ?? []) {
    if (!e || e.kind !== 'event' || e.deletedAt || e.work || !(e.peopleIds ?? []).length) continue
    const atMs = e.allDay ? new Date(`${e.start}T12:00`).getTime() : Date.parse(e.start)
    if (!Number.isFinite(atMs) || atMs > nowMs) continue
    out.push({
      kind: 'task',
      id: e.id,
      title: e.title,
      description: e.location ? `At ${e.location}` : '',
      status: 'done',
      priority: 'normal',
      completedAt: new Date(atMs).toISOString(),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      tags: ['visit'],
      peopleIds: [...e.peopleIds],
    })
  }
  return out
}

/** Soonest open catch-up / visit plan for this person, if any. */
export function plannedVisit(personId, tasks) {
  return (
    (tasks ?? [])
      .filter(t => OPEN.includes(t.status) && (t.tags ?? []).includes('visit') && (t.peopleIds ?? []).includes(personId))
      .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.updatedAt.localeCompare(b.updatedAt))[0] ?? null
  )
}

/**
 * Open gift task for an occasion (tags include 'gift' and the kind), due within
 * `windowDays` of the occasion date. Used to suppress "Plan a gift" duplicates.
 */
export function plannedGift(personId, kind, occasionAt, tasks, windowDays = 40) {
  const atMs = occasionAt instanceof Date ? occasionAt.getTime() : Date.parse(occasionAt)
  if (!Number.isFinite(atMs)) return null
  const window = windowDays * DAY_MS
  return (
    (tasks ?? []).find(t => {
      if (!OPEN.includes(t.status) || !(t.peopleIds ?? []).includes(personId)) return false
      const tags = t.tags ?? []
      if (!tags.includes('gift') || !tags.includes(kind)) return false
      if (!t.dueAt) return true
      const due = Date.parse(t.dueAt)
      return Number.isFinite(due) && Math.abs(due - atMs) <= window
    }) ?? null
  )
}

/**
 * Cadence status for one person. `nowMs` and optional `todayKey` (YYYY-MM-DD in
 * the viewer's zone) keep digest and client aligned.
 */
export function seenStatus(person, tasks, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const visits = visitsFor(person.id, tasks)
  const lastSeen = visits[0]?.at
  const daysSince = lastSeen ? Math.floor((nowMs - Date.parse(lastSeen)) / DAY_MS) : undefined
  const cadence = person.cadenceDays
  const effective = cadence ?? DEFAULT_CADENCE_DAYS
  let status
  let reason
  if (!lastSeen) {
    status = 'never'
    reason = 'No visits logged yet'
  } else if (daysSince !== undefined && daysSince > effective * 1.5) {
    status = 'overdue'
    reason = cadence
      ? `Last seen ${daysSince} days ago — you aimed for every ${cadence} days`
      : `Last seen ${daysSince} days ago (target ${DEFAULT_CADENCE_DAYS} days)`
  } else if (daysSince !== undefined && daysSince > effective) {
    status = 'due'
    reason = cadence ? `It's been ${daysSince} days; you aimed for every ${cadence} days` : `It's been ${daysSince} days`
  } else {
    status = 'ok'
    reason = daysSince === 0 ? 'Seen today' : `Last seen ${daysSince} day${daysSince === 1 ? '' : 's'} ago`
  }
  return { status, reason, lastSeen, daysSince, visits, effectiveCadenceDays: effective }
}

/**
 * Birthdays and anniversaries within `days` (today included).
 * When `todayKey` (YYYY-MM-DD) is set — digest path — compare on that calendar
 * day in UTC maths so a timezone string from user_settings stays consistent.
 * Otherwise use the runtime's local calendar (client / MCP).
 */
export function upcomingOccasions(people, days = 14, now = new Date(), todayKey) {
  const useKey = todayKey && /^\d{4}-\d{2}-\d{2}$/.test(todayKey)
  let ty, tm, td
  if (useKey) {
    ;[ty, tm, td] = todayKey.split('-').map(Number)
  } else {
    const d = now instanceof Date ? now : new Date(now)
    ty = d.getFullYear()
    tm = d.getMonth() + 1
    td = d.getDate()
  }
  const out = []
  for (const person of people ?? []) {
    for (const kind of ['birthday', 'anniversary']) {
      const raw = person[kind]
      if (!raw) continue
      const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (!m) continue
      const year = Number(m[1])
      let daysUntil
      let at
      if (useKey) {
        const todayUtc = Date.UTC(ty, tm - 1, td)
        let next = Date.UTC(ty, Number(m[2]) - 1, Number(m[3]))
        if (next < todayUtc) next = Date.UTC(ty + 1, Number(m[2]) - 1, Number(m[3]))
        daysUntil = Math.round((next - todayUtc) / DAY_MS)
        at = new Date(next)
      } else {
        const today = new Date(ty, tm - 1, td)
        let next = new Date(ty, Number(m[2]) - 1, Number(m[3]))
        if (next < today) next = new Date(ty + 1, Number(m[2]) - 1, Number(m[3]))
        daysUntil = Math.round((next.getTime() - today.getTime()) / DAY_MS)
        at = next
      }
      if (daysUntil > days) continue
      out.push({
        person,
        kind,
        at,
        daysUntil,
        years: year > 1900 ? at.getFullYear() - year : undefined,
      })
    }
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil)
}
