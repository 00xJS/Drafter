import { Post, Status, STATUSES, STATUS_META } from '../types'
import { PostCard } from './PostCard'

interface Props {
  posts: Post[]
  onOpen(p: Post): void
  onStatus(id: string, s: Status): void
  onNew(s: Status): void
}

function sortForColumn(list: Post[], s: Status): Post[] {
  const copy = [...list]
  if (s === 'scheduled') copy.sort((a, b) => (a.scheduledFor ?? '9999').localeCompare(b.scheduledFor ?? '9999'))
  else if (s === 'posted') copy.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''))
  else copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return copy
}

export function Board({ posts, onOpen, onStatus, onNew }: Props) {
  return (
    <>
      {posts.length === 0 && (
        <div className="empty-hero">
          <h2>Plan your first post</h2>
          <p>
            Hit <strong>+ New post</strong> to start a draft, or bring in your history with{' '}
            <strong>Posts → Import archive</strong>.
          </p>
        </div>
      )}
      <div className="board">
      {STATUSES.map(s => {
        const list = sortForColumn(
          posts.filter(p => p.status === s),
          s,
        )
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
              {list.map(p => (
                <PostCard key={p.id} post={p} onOpen={onOpen} />
              ))}
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
