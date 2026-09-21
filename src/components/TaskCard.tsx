import { STATUS_META, Task, TaskStatus, pickerStatuses } from '../types'
import { excerpt } from '../utils'
import { checklistProgress } from '../taskutils'
import { parseGithubUrl } from '../github'
import { DueBadge, PriorityMark, ShareMark } from './bits'
import { MemberFace } from './MemberFace'

interface Props {
  task: Task
  assignee?: string
  /** Their picture and account id, so the chip is their face rather than two letters (v3.25). */
  assigneeAvatar?: string | null
  assigneeId?: string
  /** Drawn only in a household: alone, every card would say the same thing. */
  inHousehold?: boolean
  onOpen(t: Task): void
  /** When present, the card shows a one-tap status control (works on touch, unlike drag). */
  onStatus?(id: string, status: TaskStatus): void
}

// No project chip: there is one ongoing project, so it would say the same on every card.
export function TaskCard({ task, assignee, assigneeAvatar, assigneeId, inHousehold, onOpen, onStatus }: Props) {
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
        {/* first, before the counts: who can see it is about the card itself,
            not about what is in it. The People count below uses the same 👥,
            which is why this one carries a word and that one a number. */}
        {inHousehold && <ShareMark kind="task" shared={task.shared !== false} />}
        {assignee && (
          <span className="assignee" title={assignee}>
            <MemberFace name={assignee} avatar={assigneeAvatar} id={assigneeId} size={22} />
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
