import { Post, PLATFORM_META, engagement } from '../types'
import { excerpt, fmtDateTime, fmtNum } from '../utils'

export function PostCard({ post, onOpen }: { post: Post; onOpen(p: Post): void }) {
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
      <div className="card-title">{post.title || excerpt(post.body, 40) || 'Untitled'}</div>
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
