import { Person, Project, Task } from './types'
import { DAY_MS, startOfDay } from './taskutils'
import { visitsFor } from './people'

export type Period = 'week' | 'month'

export interface Range {
  period: Period
  /** Stable id, e.g. 2026-W37 or 2026-09. */
  key: string
  start: Date
  /** Exclusive. */
  end: Date
  label: string
}

/** Monday-start ISO-ish week containing `d` (we use Sunday-start weeks in the UI, so weeks run Sun→Sat). */
export function weekRange(d: Date): Range {
  const s = startOfDay(d)
  s.setDate(s.getDate() - s.getDay())
  const e = new Date(s)
  e.setDate(e.getDate() + 7)
  const jan1 = new Date(s.getFullYear(), 0, 1)
  const week = Math.floor((s.getTime() - jan1.getTime()) / (7 * DAY_MS)) + 1
  const fmt = (x: Date) => x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const last = new Date(e.getTime() - DAY_MS)
  return { period: 'week', key: `${s.getFullYear()}-W${String(week).padStart(2, '0')}`, start: s, end: e, label: `${fmt(s)} – ${fmt(last)}` }
}

export function monthRange(d: Date): Range {
  const s = new Date(d.getFullYear(), d.getMonth(), 1)
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  return {
    period: 'month',
    key: `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}`,
    start: s,
    end: e,
    label: s.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  }
}

export function rangeFor(period: Period, d: Date): Range {
  return period === 'week' ? weekRange(d) : monthRange(d)
}

export function shiftRange(r: Range, delta: number): Range {
  if (r.period === 'week') return weekRange(new Date(r.start.getTime() + delta * 7 * DAY_MS + DAY_MS))
  return monthRange(new Date(r.start.getFullYear(), r.start.getMonth() + delta, 1))
}

export interface ReviewData {
  range: Range
  done: Task[]
  /** Open tasks whose due date fell inside the range and passed without completion. */
  slipped: Task[]
  created: Task[]
  /** Open and due inside the following period. */
  upcoming: Task[]
  overdueNow: Task[]
  /** Visits in the range, per person. */
  people: { person: Person; visits: Task[] }[]
  /** Per-project done/open counts for the range. */
  projects: { project: Project; done: number; open: number }[]
  /** Projects with nothing touched during the range. */
  stalled: Project[]
  costs: { estimate: number; actual: number }
  doneByDay: number[]
}

const inRange = (iso: string | undefined, r: Range) => !!iso && Date.parse(iso) >= r.start.getTime() && Date.parse(iso) < r.end.getTime()

export function buildReview(range: Range, tasks: Task[], projects: Project[], people: Person[], now = new Date()): ReviewData {
  const nowMs = now.getTime()
  const next = shiftRange(range, 1)
  const open = tasks.filter(t => t.status === 'todo' || t.status === 'doing' || t.status === 'blocked')
  const done = tasks.filter(t => t.status === 'done' && inRange(t.completedAt, range)).sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
  const slipped = open.filter(t => inRange(t.dueAt, range) && Date.parse(t.dueAt!) < nowMs)
  const created = tasks.filter(t => inRange(t.createdAt, range) && !t.tags.includes('visit'))
  const upcoming = open.filter(t => inRange(t.dueAt, next)).sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
  const overdueNow = open.filter(t => t.dueAt && Date.parse(t.dueAt) < nowMs).sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
  const peopleSeen = people
    .map(p => ({ person: p, visits: visitsFor(p.id, tasks).filter(v => inRange(v.at, range)).map(v => v.task) }))
    .filter(x => x.visits.length > 0)
    .sort((a, b) => b.visits.length - a.visits.length)
  const projectRows = projects
    .filter(p => p.status !== 'archived')
    .map(project => ({
      project,
      done: done.filter(t => t.projectId === project.id).length,
      open: open.filter(t => t.projectId === project.id).length,
    }))
    .filter(r => r.done > 0 || r.open > 0)
    .sort((a, b) => b.done - a.done)
  const touched = new Set<string>()
  for (const t of tasks) if (t.projectId && inRange(t.updatedAt, range)) touched.add(t.projectId)
  const stalled = projects.filter(p => p.status === 'active' && !touched.has(p.id) && !inRange(p.updatedAt, range) && Date.parse(p.createdAt) < range.start.getTime())
  const costs = {
    estimate: done.reduce((s, t) => s + (t.estimateCost ?? 0), 0),
    actual: done.reduce((s, t) => s + (t.actualCost ?? 0), 0),
  }
  const days = Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS)
  const doneByDay = Array.from({ length: days }, () => 0)
  for (const t of done) {
    const i = Math.floor((Date.parse(t.completedAt!) - range.start.getTime()) / DAY_MS)
    if (i >= 0 && i < days) doneByDay[i]++
  }
  return { range, done, slipped, created, upcoming, overdueNow, people: peopleSeen, projects: projectRows, stalled, costs, doneByDay }
}

/** Done-per-week for the last n weeks (oldest first), for the Today sparkline. */
export function doneByWeek(tasks: Task[], weeks = 12, now = new Date()): number[] {
  const thisWeek = weekRange(now)
  const out = Array.from({ length: weeks }, () => 0)
  const firstStart = thisWeek.start.getTime() - (weeks - 1) * 7 * DAY_MS
  for (const t of tasks) {
    if (t.status !== 'done' || !t.completedAt) continue
    const i = Math.floor((Date.parse(t.completedAt) - firstStart) / (7 * DAY_MS))
    if (i >= 0 && i < weeks) out[i]++
  }
  return out
}

/** Active projects with no task or project edit in `days`. */
export function stalledProjects(projects: Project[], tasks: Task[], days = 14, now = new Date()): Project[] {
  const cutoff = now.getTime() - days * DAY_MS
  const last = new Map<string, number>()
  for (const p of projects) last.set(p.id, Date.parse(p.updatedAt))
  for (const t of tasks) if (t.projectId) last.set(t.projectId, Math.max(last.get(t.projectId) ?? 0, Date.parse(t.updatedAt)))
  return projects.filter(p => p.status === 'active' && (last.get(p.id) ?? 0) < cutoff && Date.parse(p.createdAt) < cutoff)
}
