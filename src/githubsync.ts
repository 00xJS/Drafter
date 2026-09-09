import { useCallback, useEffect, useRef } from 'react'
import { BOARD_STATUSES, GithubProjectSync, Project, STATUS_META, TASK_STATUSES, Task, TaskStatus } from './types'
import { GithubFieldOption, GithubProjectItem, fetchProjectItem, fetchProjectItems, parseGithubUrl, setProjectItemFields } from './github'
import { dateKey } from './utils'

// Two-way sync with a GitHub Projects (v2) board.
//
// Push: a task's status change (and its due date, when it differs) is written
// to the board row of its linked issue, debounced so dragging a card across
// three columns is one mutation, and silent on failure — GitHub being down
// must never block a local edit.
//
// Pull: on focus and every 30 minutes each synced board is read and any task
// whose row moved *after* the task's own updatedAt is handed to the Planner as
// a change list, applied with newerStamp behind an undo toast. A task the user
// edited more recently always wins; the board never overwrites a fresh edit.
//
// Everything above the network calls is pure and tested in githubsync.test.ts.

/** Option names are compared with spacing and punctuation removed: "To do" === "to-do". */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Board names that mean a Drafter status beyond its own label. The label comes
 * first, so an exact match always wins over an alias; nothing looser than this
 * is guessed (a "Backlog" column could as easily be Wishlist as To do).
 */
const ALIASES: Partial<Record<TaskStatus, string[]>> = {
  wishlist: ['ideas', 'idea', 'someday'],
  todo: ['todo', 'ready', 'next'],
  doing: ['inprogress', 'inreview', 'active'],
  done: ['complete', 'completed', 'shipped'],
}

/**
 * First guess at the column map: match the board's Status options against the
 * Drafter status labels (Wishlist, To do, Doing, Done), case- and
 * punctuation-insensitively. An option is used once, so two statuses never
 * point at the same column by accident.
 */
export function defaultColumnMap(options: GithubFieldOption[]): Partial<Record<TaskStatus, string>> {
  const out: Partial<Record<TaskStatus, string>> = {}
  const taken = new Set<string>()
  for (const status of BOARD_STATUSES) {
    const wanted = [normalise(STATUS_META[status].label), ...(ALIASES[status] ?? [])]
    for (const want of wanted) {
      const hit = options.find(o => !taken.has(o.id) && normalise(o.name) === want)
      if (hit) {
        out[status] = hit.id
        taken.add(hit.id)
        break
      }
    }
  }
  return out
}

/** The board option a Drafter status writes into. */
export function optionForStatus(sync: GithubProjectSync | undefined, status: TaskStatus): string | undefined {
  return sync?.columns?.[status]
}

/** The Drafter status a board option means, or undefined when that column is unmapped. */
export function statusForOption(sync: GithubProjectSync | undefined, optionId: string | undefined): TaskStatus | undefined {
  if (!optionId || !sync?.columns) return undefined
  return TASK_STATUSES.find(s => sync.columns?.[s] === optionId)
}

/** Sync is on when a board URL, a status field and at least one mapped column are stored. */
export function projectSyncEnabled(p: Project | undefined): p is Project {
  if (!p?.githubUrl || !p.githubProjectSync) return false
  if (parseGithubUrl(p.githubUrl)?.type !== 'project') return false
  const { statusFieldId, dateFieldId, columns } = p.githubProjectSync
  return (!!statusFieldId && Object.keys(columns ?? {}).length > 0) || !!dateFieldId
}

/** A GitHub URL reduced to host + path, lowercased, for comparing two of them. */
function cleanGithubUrl(u: string | undefined): string {
  if (!u) return ''
  try {
    const url = new URL(u.trim())
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return u.trim().toLowerCase()
  }
}

/** Compare two GitHub URLs ignoring case, a trailing slash, and any query or hash. */
export function sameGithubUrl(a: string | undefined, b: string | undefined): boolean {
  const left = cleanGithubUrl(a)
  return !!left && left === cleanGithubUrl(b)
}

/** The board date a task wants: its due day, or null when it has none. */
export function dueDateOf(task: Task): string | null {
  return task.dueAt ? dateKey(task.dueAt) : null
}

/**
 * What a push should write for this task, given the board row as it stands.
 * Returns null when the board already agrees — an idempotent push is still a
 * mutation, and a no-op write would churn the board's own updatedAt and pull
 * the change straight back.
 *
 * Two things it will not do, both for the same reason the pull has its own
 * guards: a write to GitHub cannot be taken back from here.
 *
 * - A row GitHub touched strictly after the task's own updatedAt is left alone
 *   entirely, the same gate `reconcileProjectItems` applies in the other
 *   direction. A local edit bumps updatedAt, so the ordinary push is unaffected;
 *   only a board that moved *after* that edit wins, and the next pull brings it
 *   in rather than the push flattening it. An unreadable stamp compares false
 *   and the push goes ahead — the user's edit is the thing we know about.
 * - A task with no due date never clears the board's Date field. The pull
 *   already refuses the mirror of this ("a row with no date is never taken as
 *   'clear the due date' — silence is not intent"), and a task that never
 *   carried a due date is silence, not an instruction to wipe a date somebody
 *   set on the board.
 */
export function pushPlan(
  task: Task,
  sync: GithubProjectSync,
  item: Pick<GithubProjectItem, 'statusOptionId' | 'date' | 'updatedAt'>,
): { optionId?: string; date?: string | null } | null {
  if (Date.parse(item.updatedAt) > Date.parse(task.updatedAt)) return null
  const plan: { optionId?: string; date?: string | null } = {}
  const optionId = sync.statusFieldId ? optionForStatus(sync, task.status) : undefined
  if (optionId && optionId !== item.statusOptionId) plan.optionId = optionId
  if (sync.dateFieldId) {
    const want = dueDateOf(task)
    if (want !== null && want !== (item.date ?? null)) plan.date = want
  }
  return plan.optionId === undefined && plan.date === undefined ? null : plan
}

/**
 * Turn a board date (YYYY-MM-DD, no time) into a due instant, keeping the time
 * of day the task already had — a 09:00 reminder that slides a day must not
 * become midnight, and an untimed task must stay untimed (local midnight is
 * what `isUntimed` reads as "date only").
 */
export function boardDateToDue(day: string, previous?: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return undefined
  const old = previous ? new Date(previous) : null
  const timed = !!old && !Number.isNaN(old.getTime()) && (old.getHours() !== 0 || old.getMinutes() !== 0)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), timed ? old!.getHours() : 0, timed ? old!.getMinutes() : 0, 0, 0).toISOString()
}

/** A task the board moved: what to apply locally. */
export interface ProjectPull {
  taskId: string
  title: string
  status?: TaskStatus
  /** YYYY-MM-DD, as a Date field stores it; absent means the due date is unchanged. */
  dueDate?: string
  /** The board option's own name, for the toast. */
  columnName?: string
  /**
   * When GitHub last touched the row. Carried so the apply step can re-check it:
   * boards are fetched one after another, and a task the user edits during a
   * later fetch must still win over the row that was read before that edit.
   */
  boardUpdatedAt: string
}

/**
 * Reconcile a board's rows against the project's tasks. A row is only honoured
 * when GitHub touched it strictly after the task's own updatedAt, so an edit
 * made here is never undone by a stale board; an equal stamp is a no-op. A row
 * with no date is never taken as "clear the due date" — silence is not intent.
 *
 * One row drives at most one task. Recurrence and duplication copy `githubUrl`
 * forward, so several live tasks can carry the same issue, and a row cannot say
 * which of them it is about — completing a recurring task would otherwise push
 * Done and have the next pull mark the fresh occurrence done too. An ambiguous
 * row therefore moves nothing; pushes still work, and unlinking or trashing the
 * copy makes the survivor sync again.
 */
export function reconcileProjectItems(tasks: Task[], items: GithubProjectItem[], sync: GithubProjectSync): ProjectPull[] {
  const owner = new Map<string, Task | null>()
  for (const task of tasks) {
    if (task.deletedAt || !task.githubUrl) continue
    const key = cleanGithubUrl(task.githubUrl)
    if (!key) continue
    owner.set(key, owner.has(key) ? null : task)
  }
  const out: ProjectPull[] = []
  for (const task of tasks) {
    if (task.deletedAt || !task.githubUrl) continue
    if (owner.get(cleanGithubUrl(task.githubUrl)) !== task) continue
    const item = items.find(i => sameGithubUrl(task.githubUrl, i.contentUrl))
    if (!item) continue
    // instants, not strings: GitHub's DateTime has no milliseconds, and 'Z'
    // sorts above '.', so a lexical compare hands the board every tied second.
    // NaN from an unreadable stamp is false either way, which skips the row.
    if (!(Date.parse(item.updatedAt) > Date.parse(task.updatedAt))) continue
    const change: ProjectPull = { taskId: task.id, title: task.title, boardUpdatedAt: item.updatedAt }
    const status = statusForOption(sync, item.statusOptionId)
    // a status with no column of its own was never pushed, so the row's column
    // is stale by construction — Blocked did not become Doing because the board
    // still shows the Doing card it was never told to move
    if (status && status !== task.status && optionForStatus(sync, task.status)) {
      change.status = status
      change.columnName = item.statusName
    }
    if (sync.dateFieldId && item.date && item.date !== dueDateOf(task)) change.dueDate = item.date
    if (change.status || change.dueDate) out.push(change)
  }
  return out
}

// ---- Network side (never throws at the caller) -------------------------------

const PUSH_DELAY_MS = 2500
const timers = new Map<string, number>()

/**
 * Write a task's status / due date onto its board row. Resolves false when
 * there is nothing to do or GitHub refused — a linked board is a convenience,
 * never a precondition for editing a task.
 */
export async function pushTaskToProject(task: Task, project: Project): Promise<boolean> {
  const sync = project.githubProjectSync
  if (!sync || !project.githubUrl || !task.githubUrl) return false
  const ref = parseGithubUrl(task.githubUrl)
  if (ref?.type !== 'issue' && ref?.type !== 'pr') return false
  const fields = { statusFieldId: sync.statusFieldId, dateFieldId: sync.dateFieldId }
  try {
    const { projectId, item } = await fetchProjectItem(project.githubUrl, task.githubUrl, fields)
    if (!projectId || !item) return false
    const plan = pushPlan(task, sync, item)
    if (!plan) return false
    await setProjectItemFields({
      projectId,
      itemId: item.itemId,
      statusFieldId: plan.optionId ? sync.statusFieldId : undefined,
      optionId: plan.optionId,
      dateFieldId: plan.date !== undefined ? sync.dateFieldId : undefined,
      date: plan.date,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Queue a push, coalescing per task: dragging a card Wishlist → To do → Doing
 * fires one mutation with the status it landed on, not three.
 */
export function queueProjectPush(task: Task, project: Project | undefined, delayMs = PUSH_DELAY_MS): void {
  if (!projectSyncEnabled(project) || !task.githubUrl) return
  const board = project
  const existing = timers.get(task.id)
  if (existing !== undefined) window.clearTimeout(existing)
  timers.set(
    task.id,
    window.setTimeout(() => {
      timers.delete(task.id)
      void pushTaskToProject(task, board)
    }, delayMs),
  )
}

/** Drop any queued pushes (tests and teardown). */
export function cancelQueuedPushes(): void {
  for (const t of timers.values()) window.clearTimeout(t)
  timers.clear()
}

/**
 * Read every synced board on focus and every 30 minutes and hand the Planner
 * the tasks the board moved. Mirrors the calendar pull: build a change list,
 * apply it there with newerStamp behind an undo toast.
 *
 * `onNotice` carries the one thing a change list cannot say: that the board is
 * bigger than the read cap, so some rows were never looked at.
 */
export function useGithubProjectSync(
  projects: Project[],
  tasks: Task[],
  enabled: boolean,
  onChanges?: (changes: ProjectPull[]) => void,
  onNotice?: (message: string) => void,
): void {
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const onChangesRef = useRef(onChanges)
  onChangesRef.current = onChanges
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice
  const busy = useRef(false)
  // a board over the read cap is over it on every pull, and a toast every 30
  // minutes is noise — say it once per board per session
  const warned = useRef(new Set<string>())

  const pull = useCallback(async () => {
    if (busy.current) return
    const boards = projectsRef.current.filter(projectSyncEnabled)
    if (boards.length === 0) return
    busy.current = true
    try {
      const changes: ProjectPull[] = []
      for (const board of boards) {
        const sync = board.githubProjectSync
        if (!sync) continue
        try {
          const { items, truncated } = await fetchProjectItems(board.githubUrl!, { statusFieldId: sync.statusFieldId, dateFieldId: sync.dateFieldId })
          changes.push(...reconcileProjectItems(tasksRef.current.filter(t => t.projectId === board.id), items, sync))
          // the rows past the cap are simply absent, which reconciles to
          // "nothing moved" — indistinguishable from a board nobody touched
          if (truncated && !warned.current.has(board.id)) {
            warned.current.add(board.id)
            onNoticeRef.current?.(`${board.name}: only the first ${items.length} board rows sync — GitHub has more`)
          }
        } catch {
          /* one board being unreachable must not stop the others */
        }
      }
      if (changes.length > 0) onChangesRef.current?.(changes)
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const run = () => void pull()
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    const timer = window.setInterval(run, 30 * 60_000)
    document.addEventListener('visibilitychange', onVisible)
    run()
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, pull])
}
