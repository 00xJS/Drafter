import { useCallback, useEffect, useRef } from 'react'
import type { Project, Task, TaskStatus } from './types'
import { fetchProjectItems, parseGithubUrl } from './github'

// The shell's side of the two-way sync with a GitHub Projects board: whether a
// project syncs at all, the push queue every task edit goes through, and the
// pull on focus. Nothing syncs until a project has a board linked, so the rules
// for what a push writes and what a board row means (githubsync.ts) load with
// the first push or pull, not with the app.

/** Sync is on when a board URL, a status field and at least one mapped column are stored. */
export function projectSyncEnabled(p: Project | undefined): p is Project {
  if (!p?.githubUrl || !p.githubProjectSync) return false
  if (parseGithubUrl(p.githubUrl)?.type !== 'project') return false
  const { statusFieldId, dateFieldId, columns } = p.githubProjectSync
  return (!!statusFieldId && Object.keys(columns ?? {}).length > 0) || !!dateFieldId
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

const PUSH_DELAY_MS = 2500
const timers = new Map<string, number>()

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
      // what to write, and the write itself, load with the first push
      void import('./githubsync').then(sync => sync.pushTaskToProject(task, board)).catch(() => {})
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
          // what a row means for its task: the sync's rules, loaded with the first pull
          const { reconcileProjectItems } = await import('./githubsync')
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
