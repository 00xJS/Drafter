import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Project, Task, TaskStatus } from './types'
import { foregroundGate } from './calendarstate'
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
 * Read each board and hand on the tasks it moved. The latest tasks are read as
 * each board's rows come back, as the hook's refs hold them. Out here, not in
 * the hook: the React Compiler leaves a hook with an import() in it as written.
 */
async function pullBoards(
  boards: Project[],
  to: { tasks(): Task[]; warned: Set<string>; onNotice(message: string): void; onChanges(changes: ProjectPull[]): void },
): Promise<void> {
  const changes: ProjectPull[] = []
  for (const board of boards) {
    const sync = board.githubProjectSync
    if (!sync) continue
    try {
      const { items, truncated } = await fetchProjectItems(board.githubUrl!, { statusFieldId: sync.statusFieldId, dateFieldId: sync.dateFieldId })
      // what a row means for its task: the sync's rules, loaded with the first pull
      const { reconcileProjectItems } = await import('./githubsync')
      changes.push(...reconcileProjectItems(to.tasks().filter(t => t.projectId === board.id), items, sync))
      // the rows past the cap are simply absent, which reconciles to
      // "nothing moved" — indistinguishable from a board nobody touched
      if (truncated && !to.warned.has(board.id)) {
        to.warned.add(board.id)
        to.onNotice(`${board.name}: only the first ${items.length} board rows sync — GitHub has more`)
      }
    } catch {
      /* one board being unreachable must not stop the others */
    }
  }
  if (changes.length > 0) to.onChanges(changes)
}

/**
 * Read every synced board on launch, every 30 minutes and on a return to the
 * app, and hand the Planner the tasks the board moved. Mirrors the calendar
 * pull: build a change list, apply it there with newerStamp behind an undo
 * toast — and, as the calendar's does, a return to the app within a few
 * minutes of the last pull waits for the half-hourly one (foregroundGate):
 * every switch to another app and back read every board again.
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
  // what a pull reads when it runs, from the render last committed
  const projectsRef = useRef(projects)
  const tasksRef = useRef(tasks)
  const onChangesRef = useRef(onChanges)
  const onNoticeRef = useRef(onNotice)
  useLayoutEffect(() => {
    projectsRef.current = projects
    tasksRef.current = tasks
    onChangesRef.current = onChanges
    onNoticeRef.current = onNotice
  })
  const busy = useRef(false)
  // a board over the read cap is over it on every pull, and a toast every 30
  // minutes is noise — say it once per board per session
  const warned = useRef(new Set<string>())
  const [foreground] = useState(() => foregroundGate())

  const pull = useCallback(async () => {
    if (busy.current) return
    const boards = projectsRef.current.filter(projectSyncEnabled)
    if (boards.length === 0) return
    busy.current = true
    foreground.done()
    // .finally rather than try/finally, which the React Compiler cannot compile
    await pullBoards(boards, {
      tasks: () => tasksRef.current,
      warned: warned.current,
      onNotice: message => onNoticeRef.current?.(message),
      onChanges: changes => onChangesRef.current?.(changes),
    }).finally(() => {
      busy.current = false
    })
  }, [foreground])

  useEffect(() => {
    if (!enabled) return
    const run = () => void pull()
    const onVisible = () => {
      if (document.visibilityState === 'visible' && foreground.due()) run()
    }
    const timer = window.setInterval(run, 30 * 60_000)
    document.addEventListener('visibilitychange', onVisible)
    run()
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, pull, foreground])
}
