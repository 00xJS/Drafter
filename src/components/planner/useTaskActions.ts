import { useEffect, useRef } from 'react'
import { STATUS_META, type Project, type Task, type TaskStatus } from '../../types'
import type { Store } from '../../store'
import { newerStamp, nextOccurrence } from '../../itemops'
import { parseGithubUrl, setIssueState } from '../../github'
import { boardDateToDue, cancelQueuedPushes, projectSyncEnabled, queueProjectPush, useGithubProjectSync, type ProjectPull } from '../../githubsync'
import { fmtDateTime, uid } from '../../utils'
import { buildCapturedTask, parseCapture, quickCaptureFields } from '../../ai'
import { haptic } from '../../native'
import type { useNavigation } from './useNavigation'
import type { useOverlays } from './useOverlays'
import type { useToast } from './useToast'

interface Deps {
  store: Store
  showToast: ReturnType<typeof useToast>['showToast']
  setEditor: ReturnType<typeof useOverlays>['setEditor']
  setProjectEditor: ReturnType<typeof useOverlays>['setProjectEditor']
  setNotesProjectId: ReturnType<typeof useNavigation>['setNotesProjectId']
}

/**
 * What can be done to a task from anywhere in the shell — capture, delete,
 * change status, reschedule, defer, each with its undo — and the GitHub
 * write-back that follows (the linked issue, the project board).
 */
export function useTaskActions({ store, showToast, setEditor, setProjectEditor, setNotesProjectId }: Deps) {
  // the latest live tasks, for work that finishes after a later render (the
  // palette's capture enrichment must see an Undo that happened meanwhile)
  const tasksRef = useRef(store.tasks)
  tasksRef.current = store.tasks

  /**
   * Shift+Enter in the palette: file the line as a task now, no editor. The
   * offline parse lands at once (a keystroke must not wait on /api/ai); the
   * model's fuller reading is merged in afterwards, but only while the task is
   * still there and untouched — never over an Undo or an edit. The first toast
   * said where it went, so a merge that moves it (a project, a date) says so
   * again with its own undo, and a date the toast already announced is kept —
   * the model may add to the task, not contradict what was read out. Bypasses
   * newTask on purpose: a capture lands exactly as typed, with no preset of its own.
   */
  const captureTask = (line: string) => {
    const now = new Date()
    const id = uid()
    const lookup = { projects: store.projects, people: store.people }
    const first = buildCapturedTask(quickCaptureFields(line, now), lookup, { id, now })
    store.upsert(first)
    // Today's Inbox holds only what has neither a project nor a date
    const inbox = !first.projectId && !first.dueAt
    showToast(inbox ? 'Captured to Inbox' : `Captured — due ${fmtDateTime(first.dueAt)}`, () => store.remove(id))
    void parseCapture(line, {
      now,
      projectNames: store.projects.filter(p => p.status === 'active').map(p => p.name),
      personNames: store.people.map(p => p.name),
    })
      .then(parsed => {
        const cur = tasksRef.current.find(t => t.id === id)
        if (!cur || cur.updatedAt !== first.updatedAt) return
        const next = buildCapturedTask(parsed, lookup, { id, now })
        if (first.dueAt) next.dueAt = first.dueAt
        if (JSON.stringify(next) === JSON.stringify(first)) return
        const merged = { ...cur, ...next, createdAt: cur.createdAt, updatedAt: newerStamp(cur.updatedAt) }
        store.upsert(merged)
        const filed = !first.projectId && merged.projectId ? lookup.projects.find(p => p.id === merged.projectId)?.name : undefined
        const dated = !first.dueAt && merged.dueAt ? fmtDateTime(merged.dueAt) : undefined
        if (filed || dated) {
          const msg = filed && dated ? `Filed under ${filed} — due ${dated}` : filed ? `Filed under ${filed}` : `Due ${dated}`
          showToast(msg, () => store.upsert({ ...first, updatedAt: newerStamp(merged.updatedAt) }))
        }
      })
      .catch(() => {
        /* offline / no key — the offline parse already landed */
      })
  }

  const deleteTask = (t: Task) => {
    store.remove(t.id)
    setEditor(null)
    showToast(`Deleted “${t.title || 'Untitled'}”`, () => store.restore([t.id]))
  }

  const deleteProject = (p: Project) => {
    const count = store.tasks.filter(t => t.projectId === p.id).length
    if (count > 0 && !window.confirm(`Delete “${p.name}”? Its ${count} task${count === 1 ? '' : 's'} stay, unassigned.`)) return
    store.remove(p.id)
    setProjectEditor(null)
    // a deleted project's notepad closes back to the index
    setNotesProjectId(cur => (cur === p.id ? null : cur))
    showToast(`Deleted project “${p.name}”`, () => store.restore([p.id]))
  }

  /** Done in Drafter closes the linked GitHub issue (when the host can write). Quiet on failure. */
  const closeLinkedIssue = (t: Task) => {
    const ref = parseGithubUrl(t.githubUrl)
    if (ref?.type === 'issue') setIssueState(t.githubUrl!, 'close').then(() => showToast(`Closed ${ref.owner}/${ref.repo}#${ref.number} on GitHub`)).catch(() => {})
  }

  /**
   * Mirror a task onto its project's GitHub Projects board (column, and the due
   * date when it moved). Debounced per task so a drag across the board is one
   * mutation, and silent on failure like closeLinkedIssue: GitHub being down
   * must never block a local edit.
   */
  const pushToProjectBoard = (t: Task | undefined) => {
    if (!t?.githubUrl || !t.projectId) return
    queueProjectPush(t, store.projects.find(p => p.id === t.projectId))
  }

  /** The board moved a card: apply it here, newest edit wins, undo in the toast. */
  const applyProjectPulls = (changes: ProjectPull[]) => {
    const undo: { prev: Task; spawnedId?: string }[] = []
    for (const c of changes) {
      const t = store.tasks.find(x => x.id === c.taskId)
      if (!t) continue
      // the reconciler compared the row against the task as it stood when that
      // board was fetched; boards are read one after another, so re-check the
      // stamp here or an edit made during a later fetch loses to an older row
      if (!(Date.parse(c.boardUpdatedAt) > Date.parse(t.updatedAt))) continue
      const next: Task = { ...t }
      if (c.status) next.status = c.status
      if (c.dueDate) next.dueAt = boardDateToDue(c.dueDate, t.dueAt) ?? next.dueAt
      if (next.status === t.status && next.dueAt === t.dueAt) continue
      if (next.status === 'done' && t.status !== 'done') next.completedAt = next.completedAt ?? new Date().toISOString()
      if (next.status !== 'done') next.completedAt = undefined
      const stamped: Task = { ...next, updatedAt: newerStamp(t.updatedAt) }
      // upsert spawns the next occurrence when a recurring task crosses into
      // done, exactly as setStatus does; the id is deterministic, so this is
      // the copy the undo has to take back out again
      const spawnedId = stamped.status === 'done' && t.status !== 'done' && stamped.recurrence ? nextOccurrence(stamped, uid)?.id : undefined
      undo.push({ prev: t, spawnedId })
      store.upsert(stamped)
    }
    if (undo.length === 0) return
    const first = changes.find(c => c.taskId === undo[0].prev.id)
    const what = undo.length === 1 ? `“${undo[0].prev.title || 'Untitled'}”${first?.columnName ? ` → ${first.columnName}` : ''}` : `${undo.length} tasks`
    showToast(`${what} moved from the GitHub board`, () => {
      // undo puts the board back too, or GitHub would keep proposing the move
      for (const u of undo) {
        const restored = { ...u.prev, updatedAt: newerStamp(u.prev.updatedAt) }
        store.upsert(restored)
        pushToProjectBoard(restored)
        if (u.spawnedId) store.remove(u.spawnedId)
      }
    })
  }

  useGithubProjectSync(store.projects, store.tasks, store.loaded && store.projects.some(projectSyncEnabled), applyProjectPulls, msg => showToast(msg))

  // a queued board write outlives the edit that made it by a couple of seconds:
  // drop the pending ones when the planner goes away (sign-out, unmount)
  useEffect(() => cancelQueuedPushes, [])

  /**
   * A status move with its GitHub write-back and no toast: the linked issue
   * closes on Done and the board gets the stored task. changeStatus adds its
   * toast; a plan that moves several tasks at once says one thing for them all.
   * Returns the change (with any repeat it spawned) for an Undo.
   */
  const applyStatus = (id: string, status: TaskStatus) => {
    const change = store.setStatus(id, status)
    if (!change) return null
    if (status === 'done' && change.prev.status !== 'done') closeLinkedIssue(change.prev)
    // the stored task, not `prev` with a status on it: the board's freshness
    // guard drops a push whose stamp the row already sits after, so pushing the
    // pre-edit stamp would let the first push through and silently swallow
    // every one after it
    pushToProjectBoard(change.next)
    return change
  }

  const changeStatus = (id: string, status: TaskStatus) => {
    const change = applyStatus(id, status)
    if (!change) return
    showToast(`Moved to ${STATUS_META[status].label}`, () => {
      // the undo goes to the board too: it supersedes the queued push (same
      // task id, so the timer is replaced), and without it GitHub would keep
      // proposing the move the user just took back
      const restored = { ...change.prev, updatedAt: newerStamp(change.prev.updatedAt) }
      store.upsert(restored)
      pushToProjectBoard(restored)
      if (change.spawnedId) store.remove(change.spawnedId)
    })
  }

  /**
   * Move a task to `day`, keeping its time of day (09:00 if it had none).
   * `patch` rides on the same write: a defer from today's focus card also
   * clears focusOn, so one Undo puts back both.
   */
  const reschedule = (id: string, day: Date, patch: Partial<Task> = {}) => {
    const t = store.tasks.find(x => x.id === id)
    if (!t || t.status === 'done') return null
    const prev = { ...t }
    const old = t.dueAt ? new Date(t.dueAt) : null
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old?.getHours() ?? 9, old?.getMinutes() ?? 0)
    const next: Task = {
      ...t,
      ...patch,
      status: t.status === 'wishlist' || t.status === 'canceled' ? 'todo' : t.status,
      dueAt: at.toISOString(),
      updatedAt: newerStamp(t.updatedAt),
    }
    store.upsert(next)
    pushToProjectBoard(next)
    return prev
  }

  const defer = (id: string, day: Date, patch?: Partial<Task>) => {
    const prev = reschedule(id, day, patch)
    if (!prev) return
    const label = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    // deferring is the one daily gesture with no other confirmation you can feel
    void haptic('light')
    showToast(`Moved to ${label}`, () => {
      const restored = { ...prev, updatedAt: newerStamp(prev.updatedAt) }
      store.upsert(restored)
      pushToProjectBoard(restored)
    })
  }

  const deferAll = (ids: string[], day: Date) => {
    const undos: Task[] = []
    for (const id of ids) {
      const prev = reschedule(id, day)
      if (prev) undos.push(prev)
    }
    if (!undos.length) return
    const label = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    void haptic('light')
    showToast(`Moved ${undos.length} to ${label}`, () => {
      for (const p of undos) {
        const restored = { ...p, updatedAt: newerStamp(p.updatedAt) }
        store.upsert(restored)
        pushToProjectBoard(restored)
      }
    })
  }

  return { captureTask, deleteTask, deleteProject, closeLinkedIssue, pushToProjectBoard, applyStatus, changeStatus, reschedule, defer, deferAll }
}
