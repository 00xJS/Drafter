import { useMemo, useRef, useState } from 'react'
import { BOARD_STATUSES, PRIORITIES, PRIORITY_META, Priority, Project, STATUS_META, TASK_STATUSES, Task, TaskStatus } from '../types'
import { Store } from '../store'
import { migrateStored, STORAGE_VERSION } from '../schema'
import { compareTasks } from '../taskutils'
import { excerpt } from '../utils'
import { useMediaQuery } from '../useMediaQuery'
import { DueBadge, PriorityMark, ProjectChip } from './bits'
import { ConfirmButton } from './ConfirmButton'

interface Props {
  store: Store
  tasks: Task[]
  projectMap: Map<string, Project>
  onOpen(t: Task): void
  onNew(preset?: Partial<Task>): void
  onDelete(t: Task): void
  onOpenTrash(): void
  trashCount: number
}

type SortKey = 'due' | 'priority' | 'updated'

export function TasksTable({ store, tasks, projectMap, onOpen, onNew, onDelete, onOpenTrash, trashCount }: Props) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<TaskStatus | 'all' | 'open'>('open')
  const [priority, setPriority] = useState<Priority | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'due', dir: 1 })
  const [notice, setNotice] = useState('')
  const [showAll, setShowAll] = useState(false)
  const jsonInput = useRef<HTMLInputElement>(null)
  const isNarrow = useMediaQuery('(max-width: 640px)')

  const toggleSort = (key: SortKey) => setSort(cur => (cur.key === key ? { key, dir: cur.dir === -1 ? 1 : -1 } : { key, dir: key === 'due' ? 1 : -1 }))
  const sortArrow = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ▼' : ' ▲') : '')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return tasks
      .filter(t => status === 'all' || (status === 'open' ? t.status !== 'done' && t.status !== 'canceled' : t.status === status))
      .filter(t => priority === 'all' || t.priority === priority)
      .filter(t => !needle || (t.title + ' ' + t.description + ' ' + t.tags.join(' ') + ' ' + (t.projectId ? projectMap.get(t.projectId)?.name ?? '' : '')).toLowerCase().includes(needle))
      .sort((a, b) => {
        if (sort.key === 'due') return sort.dir * compareTasks(a, b)
        if (sort.key === 'priority') return sort.dir * (PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank)
        return sort.dir * a.updatedAt.localeCompare(b.updatedAt)
      })
  }, [tasks, q, status, priority, sort, projectMap])

  const visible = showAll ? filtered : filtered.slice(0, 200)
  const statusChoices = useMemo(() => {
    const leftover = TASK_STATUSES.filter(s => !BOARD_STATUSES.includes(s) && tasks.some(t => t.status === s))
    return leftover.length ? [...BOARD_STATUSES, ...leftover] : BOARD_STATUSES
  }, [tasks])

  function exportJSON() {
    const payload = { version: STORAGE_VERSION, exportedAt: new Date().toISOString(), items: store.visibleItems }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `drafter-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function onJSONFile(file: File) {
    try {
      const migrated = migrateStored(JSON.parse(await file.text()))
      if (!migrated) throw new Error('expected a Drafter backup (array, {version, posts} or {version, items})')
      const s = store.importItems(migrated)
      setNotice(`JSON import: ${s.added} new, ${s.updated} updated, ${s.unchanged} unchanged.`)
    } catch (e) {
      setNotice(`JSON import failed: ${(e as Error).message}`)
    }
  }

  const actions = (
    <>
      <button className="btn" onClick={() => onNew({ status: 'done', completedAt: new Date().toISOString() })}>
        Log something done
      </button>
      <button className="btn" onClick={() => jsonInput.current?.click()}>
        Import JSON
      </button>
      <button className="btn" onClick={exportJSON}>
        Export JSON
      </button>
      <button className="btn" onClick={onOpenTrash}>
        Trash{trashCount > 0 ? ` (${trashCount})` : ''}
      </button>
    </>
  )

  return (
    <div className="posts-view">
      <div className="toolbar">
        <input className="search" placeholder="Search tasks…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={status} onChange={e => setStatus(e.target.value as TaskStatus | 'all' | 'open')}>
          <option value="open">Open</option>
          <option value="all">All statuses</option>
          {statusChoices.map(s => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </select>
        <select value={priority} onChange={e => setPriority(e.target.value as Priority | 'all')}>
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
        {isNarrow ? (
          <details className="action-menu">
            <summary className="btn">Import / Export ▾</summary>
            <div className="action-menu-items">{actions}</div>
          </details>
        ) : (
          actions
        )}
        <input
          ref={jsonInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) onJSONFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {notice && (
        <div className="notice">
          {notice}
          <button className="btn subtle" onClick={() => setNotice('')}>
            ✕
          </button>
        </div>
      )}

      {isNarrow ? (
        <ul className="mpost-list">
          {visible.map(t => {
            const project = t.projectId ? projectMap.get(t.projectId) : undefined
            return (
              <li key={t.id} className="mpost" onClick={() => onOpen(t)}>
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
                  {project && <ProjectChip project={project} />}
                  <DueBadge task={t} />
                  <span className="spacer" />
                  <ConfirmButton className="btn subtle danger" stopPropagation confirmLabel="Sure? Click again" onConfirm={() => onDelete(t)}>
                    Delete
                  </ConfirmButton>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="table-scroll">
          <table className="posts-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Project</th>
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
              {visible.map(t => {
                const project = t.projectId ? projectMap.get(t.projectId) : undefined
                return (
                  <tr key={t.id} onClick={() => onOpen(t)}>
                    <td>
                      <button type="button" className="row-open row-title">
                        {t.title || excerpt(t.description, 48) || 'Untitled'}
                      </button>
                      {t.title && t.description && <div className="row-body">{excerpt(t.description, 70)}</div>}
                    </td>
                    <td>{project ? <ProjectChip project={project} /> : <span className="muted">—</span>}</td>
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
                )
              })}
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
        <p className="empty">
          No tasks match.{' '}
          <button type="button" className="btn subtle" onClick={() => onNew()}>
            + New task
          </button>
        </p>
      )}
    </div>
  )
}
