import { Project, STATUS_META, Task, TaskStatus, pickerStatuses } from '../types'
import { excerpt } from '../utils'
import { checklistProgress } from '../taskutils'
import { parseGithubUrl } from '../github'
import { DueBadge, PriorityMark, ProjectChip } from './bits'

interface Props {
  task: Task
  project?: Project
  assignee?: string
  onOpen(t: Task): void
  /** When present, the card shows a one-tap status control (works on touch, unlike drag). */
  onStatus?(id: string, status: TaskStatus): void
}

export function TaskCard({ task, project, assignee, onOpen, onStatus }: Props) {
  const check = checklistProgress(task)
  const gh = parseGithubUrl(task.githubUrl)

  return (
    <article
      className={`card prio-border-${task.priority}`}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => onOpen(task)}
    >
      <div className="card-title-row">
        <button type="button" className="row-open card-title">
          <PriorityMark priority={task.priority} /> {task.title || excerpt(task.description, 40) || 'Untitled'}
        </button>
        {onStatus && (
          <span className="card-status" onClick={e => e.stopPropagation()}>
            <span className="card-status-icon" aria-hidden>
              ⇄
            </span>
            <select value={task.status} aria-label="Change status" onChange={e => onStatus(task.id, e.target.value as TaskStatus)}>
              {pickerStatuses(task.status).map(s => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      {task.description && <div className="card-body">{excerpt(task.description)}</div>}
      <div className="card-meta">
        {project && <ProjectChip project={project} />}
        {assignee && (
          <span className="assignee" title={assignee}>
            {assignee
              .split(/[\s@._-]+/)
              .filter(Boolean)
              .slice(0, 2)
              .map(s => s[0]!.toUpperCase())
              .join('')}
          </span>
        )}
        {check && (
          <span className="card-flag" title="Checklist">
            ☑ {check.done}/{check.total}
          </span>
        )}
        {task.comments && task.comments.length > 0 && (
          <span className="card-flag" title="Comments">
            💬 {task.comments.length}
          </span>
        )}
        {gh && (
          <span className="card-flag" title={task.githubUrl}>
            {gh.type === 'pr' ? '⎇' : gh.type === 'issue' ? '◉' : '⌥'} {gh.number ? `#${gh.number}` : gh.repo ?? 'GH'}
          </span>
        )}
        {task.peopleIds && task.peopleIds.length > 0 && (
          <span className="card-flag" title="People">
            👥 {task.peopleIds.length}
          </span>
        )}
        {task.mediaIds && task.mediaIds.length > 0 && <span className="card-flag">🖼 {task.mediaIds.length}</span>}
        {task.recurrence && (
          <span className="card-flag" title="Repeats">
            ↻
          </span>
        )}
        <DueBadge task={task} />
      </div>
      {task.tags.length > 0 && (
        <div className="card-tags">
          {task.tags.map(t => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
        </div>
      )}
    </article>
  )
}
