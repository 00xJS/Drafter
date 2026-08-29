import { Post, PLATFORM_META, STATUSES, STATUS_META, Status, engagement } from '../types'
import { excerpt, fmtDateTime, fmtNum } from '../utils'

interface Props {
  post: Post
  onOpen(p: Post): void
  /** When present, the card shows a one-tap status control (works on touch, unlike drag). */
  onStatus?(id: string, status: Status): void
}

export function PostCard({ post, onOpen, onStatus }: Props) {
  const date =
    post.status === 'posted'
      ? fmtDateTime(post.postedAt)
      : post.status === 'scheduled'
        ? post.scheduledFor
          ? fmtDateTime(post.scheduledFor)
          : 'Unscheduled'
        : ''
  const eng = engagement(post)

  return (
    <article
      className="card"
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', post.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => onOpen(post)}
    >
      <div className="card-title-row">
        <div className="card-title">{post.title || excerpt(post.body, 40) || 'Untitled'}</div>
        {onStatus && (
          <span className="card-status" onClick={e => e.stopPropagation()}>
            <span className="card-status-icon" aria-hidden>
              ⇄
            </span>
            <select
              value={post.status}
              aria-label="Change status"
              onChange={e => onStatus(post.id, e.target.value as Status)}
            >
              {STATUSES.map(s => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      {post.body && <div className="card-body">{excerpt(post.body)}</div>}
      <div className="card-meta">
        <span className="chips">
          {post.platforms.map(pl => (
            <span key={pl} className="chip platform" style={{ background: PLATFORM_META[pl].color }}>
              {PLATFORM_META[pl].short}
            </span>
          ))}
        </span>
        {post.mediaIds && post.mediaIds.length > 0 && <span className="card-flag">🖼 {post.mediaIds.length}</span>}
        {post.recurrence && <span className="card-flag" title="Repeats">↻</span>}
        {date && <span className="card-date">{date}</span>}
        {post.status === 'posted' && eng > 0 && <span className="card-eng">♥ {fmtNum(eng)}</span>}
      </div>
      {post.tags.length > 0 && (
        <div className="card-tags">
          {post.tags.map(t => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
        </div>
      )}
    </article>
  )
}
