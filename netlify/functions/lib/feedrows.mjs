// The rows the ICS feed publishes for one reader: pure, so it can be tested.
//
// This lives in lib/ on purpose. Netlify treats every script file at the top of
// netlify/functions as a function, and a declaration file sitting beside
// feed.mjs (feed.d.mts) was picked up as a function called "feed.d" with no
// handler — which is what stopped the deploy of 4297356. lib/ is not scanned.
import { isMineTask, isUntimed, localDate } from '../../../shared/domain.mjs'

const DAY = 86_400_000
const OPEN = ['todo', 'doing', 'blocked']

/** The row's owner, as the app would see it. Exported for the tests. */
export function withOwner(item, userId) {
  return item && typeof item === 'object' && userId ? { ...item, ownerId: userId } : item
}

/** The day before a YYYY-MM-DD key. UTC arithmetic: a date key carries no time, so no DST applies. */
function prevDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  if (!m) return undefined
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function feedFor(items, site, tz, myId) {
  const projects = new Map(items.filter(i => i.kind === 'project').map(p => [p.id, p]))
  const feed = []
  const cutoff = Date.now() - 30 * DAY
  for (const t of items) {
    if (t.kind !== 'task' || !t.dueAt) continue
    if (!isMineTask(t, myId)) continue
    const isOpen = OPEN.includes(t.status)
    const recentlyDone = t.status === 'done' && t.completedAt && Date.parse(t.completedAt) > cutoff
    if (!isOpen && !recentlyDone) continue
    const project = t.projectId ? projects.get(t.projectId) : null
    const start = Date.parse(t.dueAt)
    const timed = !isUntimed(t.dueAt, tz)
    const prefix = t.status === 'done' ? '✓ ' : t.priority === 'urgent' ? '‼ ' : t.priority === 'high' ? '▲ ' : ''
    feed.push({
      uid: `task-${t.id}@drafter`,
      // a task marks something due, not a meeting: free time, as both mirrors publish it
      transparent: true,
      title: `${prefix}${t.title || 'Untitled task'}${project ? ` · ${project.name}` : ''}`,
      start,
      end: timed ? start + 3_600_000 : undefined,
      allDay: !timed,
      // the reader's own calendar day, not the UTC one: an untimed task is
      // stored at local midnight, which is the previous day in UTC all summer
      date: timed ? undefined : localDate(t.dueAt, tz),
      description: [t.description, t.checklist?.length ? `Checklist: ${t.checklist.filter(c => c.done).length}/${t.checklist.length}` : '', `Status: ${t.status} · Priority: ${t.priority}`]
        .filter(Boolean)
        .join('\n\n'),
      url: site,
      categories: [project?.name, ...(t.tags ?? [])].filter(Boolean),
    })
  }
  for (const p of projects.values()) {
    if (p.status === 'archived' || p.status === 'done') continue
    if (p.ownerId && myId && p.ownerId !== myId) continue
    if (p.targetAt) feed.push({ transparent: true, uid: `project-${p.id}@drafter`, title: `🎯 ${p.name} target`, start: Date.parse(p.targetAt), allDay: true, date: localDate(p.targetAt, tz), description: p.description, url: site, categories: [p.name] })
    for (const m of p.milestones ?? []) {
      if (!m.dueAt) continue
      feed.push({ transparent: true, uid: `milestone-${p.id}-${m.id}@drafter`, title: `${m.done ? '✓' : '◆'} ${m.name} · ${p.name}`, start: Date.parse(m.dueAt), allDay: true, date: localDate(m.dueAt, tz), url: site, categories: [p.name] })
    }
  }
  // Entries the user wrote themselves. These are the only rows in the feed with
  // a real duration — everything else marks a moment — so they are the ones a
  // subscribed calendar can show as busy.
  for (const e of items) {
    if (e.kind !== 'event' || e.deletedAt || !e.start) continue
    if (e.ownerId && myId && e.ownerId !== myId) continue
    feed.push({
      uid: `event-${e.id}@drafter`,
      title: e.title || 'Untitled event',
      start: Date.parse(e.allDay ? `${e.start}T12:00:00Z` : e.start),
      end: e.allDay ? undefined : Date.parse(e.end),
      allDay: !!e.allDay,
      // all-day rows carry their day keys straight through: they are already
      // the reader's own calendar days, so nothing needs converting
      date: e.allDay ? e.start : undefined,
      // stored end is EXCLUSIVE (the ICS convention); buildICS wants the last
      // day INCLUSIVE and re-adds the day itself, so step back one
      endDate: e.allDay ? prevDayKey(e.end) : undefined,
      description: e.notes,
      // a work day is working hours, not a meeting: publish it as free time
      transparent: !!e.work,
      url: site,
    })
  }
  return feed
}

function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY
  return { apikey: key, authorization: `Bearer ${key}` }
}

const baseUrl = () => process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
