import { useEffect, useMemo, useState } from 'react'
import { BOARD_STATUSES, PRIORITIES, PRIORITY_META, Priority, STATUS_META, TASK_STATUSES, Task, TaskStatus } from '../types'
import { compareTasks } from '../taskutils'
import { excerpt, scrollBehavior } from '../utils'
import { useMediaQuery } from '../useMediaQuery'
import { DueBadge, PriorityMark, ShareMark } from './bits'
import { ConfirmButton } from './ConfirmButton'

interface Props {
  tasks: Task[]
  onOpen(t: Task): void
  onNew(preset?: Partial<Task>): void
  onDelete(t: Task): void
  /** Drawn only in a household: alone there is nobody to share with. */
  inHousehold?: boolean
  /** The reader's own account id, so a housemate's row can be named. */
  myId?: string | null
  /** A member's display name, for "Maria" on a task of theirs. */
  nameOf?(id: string | undefined): string | null
  /**
   * A task to bring into view — one just logged as done, which Open hides:
   * the status filter moves to the task's own, and its row is scrolled to.
   * Consumed once (onRevealed), whether the list was up or not.
   */
  reveal?: string | null
  onRevealed?(): void
}

type StatusFilter = TaskStatus | 'all' | 'open'

/** The filter that shows `t`: Open while it is open, its own status once it is done or canceled. */
const filterShowing = (t: Task | undefined): StatusFilter => (t && (t.status === 'done' || t.status === 'canceled') ? t.status : 'open')

type SortKey = 'due' | 'priority' | 'updated'

// No project column or chip, and a search that reads no project name: there is
// one ongoing project, so it would say the same on every row.
export function TasksTable({ tasks, onOpen, onNew, onDelete, inHousehold, myId, nameOf, reveal = null, onRevealed }: Props) {
  const [q, setQ] = useState('')
  // a task handed over to show sets the filter as the list first draws, and
  // again if one is handed over while the list is up
  const [status, setStatus] = useState<StatusFilter>(() => (reveal ? filterShowing(tasks.find(t => t.id === reveal)) : 'open'))
  const [revealed, setRevealed] = useState(reveal)
  if (reveal !== revealed) {
    setRevealed(reveal)
    if (reveal) {
      setStatus(filterShowing(tasks.find(t => t.id === reveal)))
      setQ('')
    }
  }
  useEffect(() => {
    if (!reveal) return
    onRevealed?.()
    document.getElementById(`task-row-${reveal}`)?.scrollIntoView?.({ block: 'center', behavior: scrollBehavior() })
  }, [reveal, onRevealed])
  const [priority, setPriority] = useState<Priority | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'due', dir: 1 })
  const [notice, setNotice] = useState('')
  const [showAll, setShowAll] = useState(false)
  const isNarrow = useMediaQuery('(max-width: 640px)')

  // whose row it is, said on the row itself: 🔒 on the ones the other member
  // cannot see, 👥 on the ones they can, with their name on rows of theirs
  const mark = (t: Task) =>
    inHousehold ? <ShareMark kind="task" shared={t.shared !== false} by={t.ownerId && t.ownerId !== myId ? (nameOf?.(t.ownerId) ?? 'Shared') : undefined} /> : null

  const toggleSort = (key: SortKey) => setSort(cur => (cur.key === key ? { key, dir: cur.dir === -1 ? 1 : -1 } : { key, dir: key === 'due' ? 1 : -1 }))
  const sortArrow = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ▼' : ' ▲') : '')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return tasks
      .filter(t => status === 'all' || (status === 'open' ? t.status !== 'done' && t.status !== 'canceled' : t.status === status))
      .filter(t => priority === 'all' || t.priority === priority)
      .filter(t => !needle || (t.title + ' ' + t.description + ' ' + t.tags.join(' ')).toLowerCase().includes(needle))
      .sort((a, b) => {
        if (sort.key === 'due') return sort.dir * compareTasks(a, b)
        if (sort.key === 'priority') return sort.dir * (PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank)
        return sort.dir * a.updatedAt.localeCompare(b.updatedAt)
      })
  }, [tasks, q, status, priority, sort])

  const visible = showAll ? filtered : filtered.slice(0, 200)
  const needle = q.trim()
  // with no search, a task the priority filter keeps but the list does not show is one the status filter hides
  const hiddenByStatus = !needle && status !== 'all' && tasks.some(t => priority === 'all' || t.priority === priority)
  const statusChoices = useMemo(() => {
    const leftover = TASK_STATUSES.filter(s => !BOARD_STATUSES.includes(s) && tasks.some(t => t.status === s))
    return leftover.length ? [...BOARD_STATUSES, ...leftover] : BOARD_STATUSES
  }, [tasks])

  /**
   * What the toolbar keeps. Import and Export JSON went to Settings → Data
   * (v3.28): at 375pt they took the only free slot on the row and hid the
   * Trash behind an "Import / Export" menu, so the one control anybody
   * actually reaches for was the one you could not see. Moving data in and
   * out is a once-a-year thing and belongs where the other data controls are;
   * the Trash is now an icon on the segment row above (TasksScreen).
   */
  const actions = (
    // quieter than a new task, which is + in the header: this one is for
    // writing down what is already finished
    <button type="button" className="btn subtle log-done" onClick={() => onNew({ status: 'done', completedAt: new Date().toISOString() })}>
      ✓ Log a finished task
    </button>
  )

  return (
    <div className="posts-view">
      <div className="toolbar">
        <input className="search" aria-label="Search tasks" placeholder="Search tasks…" value={q} onChange={e => setQ(e.target.value)} />
        {/* named, like every other control here: without a label a screen
            reader reads only the current option — "Open, combo box" — which
            says nothing about what it filters */}
        <select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value as StatusFilter)}>
          <option value="open">Open</option>
          <option value="all">All statuses</option>
          {statusChoices.map(s => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </select>
        <select aria-label="Filter by priority" value={priority} onChange={e => setPriority(e.target.value as Priority | 'all')}>
          <option value="all">Any priority</option>
          {PRIORITIES.map(p => (
            <option key={p} value={p}>
              {PRIORITY_META[p].label}
            </option>
          ))}
        </select>
        {isNarrow && (
          <span className="segmented sort-seg">
            <button className={sort.key === 'due' ? 'seg on' : 'seg'} onClick={() => toggleSort('due')}>
              Due{sortArrow('due')}
            </button>
            <button className={sort.key === 'priority' ? 'seg on' : 'seg'} onClick={() => toggleSort('priority')}>
              Prio{sortArrow('priority')}
            </button>
          </span>
        )}
        <span className="spacer" />
        {actions}
      </div>

      {notice && (
        <div className="notice">
          {notice}
          <button type="button" className="btn subtle" aria-label="Dismiss" onClick={() => setNotice('')}>
            ✕
          </button>
        </div>
      )}

      {isNarrow ? (
        <ul className="mpost-list">
          {visible.map(t => (
            <li key={t.id} id={`task-row-${t.id}`} className="mpost" onClick={() => onOpen(t)}>
              <div className="mpost-top">
                <button type="button" className="row-open">
                  <span className="row-title">
                    <PriorityMark priority={t.priority} /> {t.title || excerpt(t.description, 48) || 'Untitled'}
                  </span>
                </button>
                <span className="badge" style={{ background: STATUS_META[t.status].bg, color: STATUS_META[t.status].color }}>
                  {STATUS_META[t.status].label}
                </span>
              </div>
              {t.title && t.description && <div className="row-body">{excerpt(t.description, 90)}</div>}
              <div className="mpost-meta">
                {mark(t)}
                <DueBadge task={t} />
                <span className="spacer" />
                <ConfirmButton className="btn subtle danger" stopPropagation confirmLabel="Sure? Click again" onConfirm={() => onDelete(t)}>
                  Delete
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="table-scroll">
          <table className="posts-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>
                  <button className="th-sort" onClick={() => toggleSort('priority')}>
                    Priority{sortArrow('priority')}
                  </button>
                </th>
                <th>
                  <button className="th-sort" onClick={() => toggleSort('due')}>
                    Due{sortArrow('due')}
                  </button>
                </th>
                <th>
                  <button className="th-sort" onClick={() => toggleSort('updated')}>
                    Updated{sortArrow('updated')}
                  </button>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(t => (
                <tr key={t.id} id={`task-row-${t.id}`} onClick={() => onOpen(t)}>
                  <td>
                    <button type="button" className="row-open row-title">
                      {t.title || excerpt(t.description, 48) || 'Untitled'}
                    </button>{' '}
                    {mark(t)}
                    {t.title && t.description && <div className="row-body">{excerpt(t.description, 70)}</div>}
                  </td>
                  <td>
                    <span className="badge" style={{ background: STATUS_META[t.status].bg, color: STATUS_META[t.status].color }}>
                      {STATUS_META[t.status].label}
                    </span>
                  </td>
                  <td>
                    <PriorityMark priority={t.priority} withLabel />
                  </td>
                  <td className="cell-date">{t.dueAt ? <DueBadge task={t} /> : '—'}</td>
                  <td className="cell-date">{new Date(t.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <ConfirmButton className="btn subtle danger" stopPropagation confirmLabel="Sure? Click again" onConfirm={() => onDelete(t)}>
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > visible.length && (
        <button className="btn show-all" onClick={() => setShowAll(true)}>
          Show all {filtered.length} tasks
        </button>
      )}
      {filtered.length === 0 && (
        <TasksEmpty
          query={needle}
          status={status}
          hiddenByStatus={hiddenByStatus}
          noTasks={tasks.length === 0}
          onNew={() => onNew()}
          onShowAll={() => setStatus('all')}
        />
      )}
    </div>
  )
}

/**
 * An empty list says why it is empty. A search that found nothing says what
 * was searched for. A status filter hiding every task — everything done, say —
 * is good news rather than a failed search, so it says so and offers the way
 * back to all of them. Otherwise the priority filter left nothing, or there
 * are no tasks at all.
 */
export function TasksEmpty({
  query,
  status,
  hiddenByStatus,
  noTasks,
  onNew,
  onShowAll,
}: {
  query: string
  status: TaskStatus | 'all' | 'open'
  /** The list would have rows with every status showing. */
  hiddenByStatus: boolean
  noTasks: boolean
  onNew(): void
  onShowAll(): void
}) {
  const byStatus = !query && hiddenByStatus && status !== 'all'
  const text = query
    ? `No tasks match “${query}”.`
    : byStatus
      ? status === 'open'
        ? 'Nothing open here — nice.'
        : `Nothing in ${STATUS_META[status].label}.`
      : noTasks
        ? 'No tasks yet.'
        : 'No tasks match.'
  return (
    <p className="empty">
      {text}{' '}
      <button type="button" className="btn subtle" onClick={onNew}>
        + New task
      </button>
      {byStatus && (
        <>
          {' '}
          <button type="button" className="btn subtle" onClick={onShowAll}>
            Show all statuses
          </button>
        </>
      )}
    </p>
  )
}
