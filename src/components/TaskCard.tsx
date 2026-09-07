import { PLATFORM_META, Project, TASK_STATUSES, STATUS_META, Task, TaskStatus, engagement } from '../types'
import { excerpt, fmtNum } from '../utils'
import { checklistProgress } from '../taskutils'
import { parseGithubUrl } from '../github'
import { DueBadge, PriorityMark, ProjectChip } from './bits'

interface Props {
  task: Task
  project?: Project
  onOpen(t: Task): void
  /** When present, the card shows a one-tap status control (works on touch, unlike drag). */
  onStatus?(id: string, status: TaskStatus): void
}

export function TaskCard({ task, project, onOpen, onStatus }: Props) {
  const check = checklistProgress(task)
  const gh = parseGithubUrl(task.githubUrl)
  const eng = task.social ? engagement({ metrics: task.social.metrics }) : 0

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
        <div className="card-title">
          <PriorityMark priority={task.priority} /> {task.title || excerpt(task.description, 40) || 'Untitled'}
        </div>
        {onStatus && (
          <span className="card-status" onClick={e => e.stopPropagation()}>
            <span className="card-status-icon" aria-hidden>
              ⇄
            </span>
            <select value={task.status} aria-label="Change status" onChange={e => onStatus(task.id, e.target.value as TaskStatus)}>
              {TASK_STATUSES.map(s => (
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
        {task.social && (
          <span className="chips">
            {task.social.platforms.map(pl => (
              <span key={pl} className="chip platform" style={{ background: PLATFORM_META[pl].color }}>
                {PLATFORM_META[pl].short}
              </span>
            ))}
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
        {task.status === 'done' && eng > 0 && <span className="card-eng">♥ {fmtNum(eng)}</span>}
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
