import { PRIORITY_META, Project, TASK_STATUSES, STATUS_META, Task, TaskStatus } from '../types'
import { compareTasks } from '../taskutils'
import { TaskCard } from './TaskCard'

interface Props {
  tasks: Task[]
  projects: Map<string, Project>
  members: { id: string; displayName: string }[]
  /** True when the board is showing every project (cards then carry a project chip). */
  showProject: boolean
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
  onNew(s: TaskStatus): void
}

function sortForColumn(list: Task[], s: TaskStatus): Task[] {
  const copy = [...list]
  if (s === 'done') copy.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
  else if (s === 'wishlist')
    copy.sort((a, b) => PRIORITY_META[b.priority].rank - PRIORITY_META[a.priority].rank || b.updatedAt.localeCompare(a.updatedAt))
  else if (s === 'canceled') copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  else copy.sort(compareTasks)
  return copy
}

const DONE_CAP = 30

export function Board({ tasks, projects, members, showProject, onOpen, onStatus, onNew }: Props) {
  return (
    <>
      {tasks.length === 0 && (
        <div className="empty-hero">
          <h2>An empty board</h2>
          <p>
            Hit <strong>+ New task</strong> to capture something, or park ideas in <strong>Wishlist</strong> until they
            earn a due date.
          </p>
        </div>
      )}
      <div className="board">
        {TASK_STATUSES.map(s => {
          const list = sortForColumn(
            tasks.filter(t => t.status === s),
            s,
          )
          const shown = s === 'done' ? list.slice(0, DONE_CAP) : list
          return (
            <section
              key={s}
              className="board-col"
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/plain')
                if (id) onStatus(id, s)
              }}
            >
              <header className="board-col-head">
                <span className="status-dot" style={{ background: STATUS_META[s].color }} />
                <span>{STATUS_META[s].label}</span>
                <span className="board-count">{list.length}</span>
              </header>
              <div className="board-cards">
                {shown.map(t => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    project={showProject && t.projectId ? projects.get(t.projectId) : undefined}
                    assignee={t.assigneeId ? members.find(m => m.id === t.assigneeId)?.displayName : undefined}
                    onOpen={onOpen}
                    onStatus={onStatus}
                  />
                ))}
                {s === 'done' && list.length > DONE_CAP && (
                  <p className="board-more">+ {list.length - DONE_CAP} older — see the Tasks tab</p>
                )}
              </div>
              <button className="board-add" onClick={() => onNew(s)}>
                + Add
              </button>
            </section>
          )
        })}
      </div>
    </>
  )
}
