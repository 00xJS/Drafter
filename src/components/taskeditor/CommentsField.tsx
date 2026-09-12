import { useState } from 'react'
import { newerStamp } from '../../itemops'
import { SetForm } from '../../taskform'
import { Comment, Task } from '../../types'
import { fmtDateTime, uid } from '../../utils'

interface Props {
  comments: Comment[]
  set: SetForm
  /** A saved task: a comment is written (or removed) at once, onto the freshest copy. */
  persisted: boolean
  latest(): Task
  onCommit(t: Task): void
}

/** Progress notes, decisions and blockers, newest last. */
export function CommentsField({ comments, set, persisted, latest, onCommit }: Props) {
  const [newComment, setNewComment] = useState('')

  function addComment() {
    const body = newComment.trim()
    if (!body) return
    const c: Comment = { id: uid(), body, createdAt: new Date().toISOString() }
    set(f => ({ comments: [...f.comments, c] }))
    setNewComment('')
    if (persisted) {
      const current = latest()
      onCommit({ ...current, comments: [...(current.comments ?? []), c], updatedAt: newerStamp(current.updatedAt) })
    }
  }

  function removeComment(id: string) {
    set(f => ({ comments: f.comments.filter(c => c.id !== id) }))
    if (persisted) {
      const current = latest()
      const rest = (current.comments ?? []).filter(c => c.id !== id)
      onCommit({ ...current, comments: rest.length > 0 ? rest : undefined, updatedAt: newerStamp(current.updatedAt) })
    }
  }

  return (
    <div className="field">
      <span>
        Comments {comments.length > 0 && <small>({comments.length})</small>}
      </span>
      <ul className="comments">
        {comments.map(c => (
          <li key={c.id} className="comment">
            <div className="comment-meta">
              <span>{fmtDateTime(c.createdAt)}</span>
              <button type="button" className="btn subtle" aria-label="Delete comment" onClick={() => removeComment(c.id)}>
                ✕
              </button>
            </div>
            <div className="comment-body">{c.body}</div>
          </li>
        ))}
      </ul>
      <div className="comment-form">
        <textarea
          rows={2}
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          placeholder={persisted ? 'Progress note, decision, blocker… (saves immediately)' : 'Progress note, decision, blocker…'}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              addComment()
            }
          }}
        />
        <button type="button" className="btn" disabled={!newComment.trim()} onClick={addComment}>
          Comment
        </button>
      </div>
    </div>
  )
}
