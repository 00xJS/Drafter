import { SetForm, TaskForm } from '../../taskform'
import { PRIORITIES, PRIORITY_META, STATUS_META, Task, pickerStatuses } from '../../types'

interface Props {
  form: Pick<TaskForm, 'assigneeId' | 'status' | 'priority' | 'blockedBy' | 'shared'>
  set: SetForm
  /** Household members (empty when not in a household). */
  members: { id: string; displayName: string }[]
  /** Open tasks that could block this one. */
  candidates: Task[]
  /** This task's own id, never offered as its own blocker. */
  taskId: string
  /** The reader's own account id, so "assigned to someone else" can be told from "assigned to me". */
  myId?: string | null
}

/**
 * Who's doing it, status, priority and blockers. There is no project picker:
 * there is one home project, a new task takes one only from a preset, template
 * or Draft a plan, and a saved task keeps its own.
 */
export function AssignFields({ form, set, members, candidates, taskId, myId }: Props) {
  const { assigneeId, status, priority, blockedBy, shared } = form
  // Whose job it is and who can see it are different questions, but one answer
  // rules out the other: a task the other member is meant to do cannot be kept
  // from them. Said and refused here rather than allowed and then undone by
  // the server, which would look like the app losing an edit.
  const theirs = !!assigneeId && !!myId && assigneeId !== myId
  const assignee = theirs ? members.find(m => m.id === assigneeId)?.displayName : undefined
  return (
    <>
      {members.length > 1 && (
        <label className="field">
          <span>Who's doing it</span>
          <select
            value={assigneeId}
            onChange={e => {
              // handing it to the other member shares it: they cannot do a task they cannot see
              const id = e.target.value
              set(myId && id && id !== myId ? { assigneeId: id, shared: true } : { assigneeId: id })
            }}
          >
            <option value="">Anyone</option>
            {members.map(m => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      )}

      {members.length > 1 && (
        <div className="field">
          <span>Who can see it</span>
          <div className="segmented">
            <button type="button" className={shared ? 'seg on' : 'seg'} aria-pressed={shared} onClick={() => set({ shared: true })}>
              👥 Shared
            </button>
            <button
              type="button"
              className={!shared ? 'seg on' : 'seg'}
              aria-pressed={!shared}
              disabled={theirs}
              title={theirs ? `${assignee ?? 'The other member'} is doing this one, so it cannot be kept from them.` : undefined}
              onClick={() => set({ shared: false })}
            >
              🔒 Private
            </button>
          </div>
          <small className="muted">
            {theirs
              ? `${assignee ?? 'Someone else'} is doing this one — pick Anyone or yourself above to keep it private.`
              : shared
                ? 'Everyone in your household can see this task.'
                : 'Only you can see this task — it stays out of their list, their board and their calendar.'}
          </small>
        </div>
      )}

      <div className="field">
        <span>Status</span>
        <div className="segmented wrap">
          {pickerStatuses(status).map(s => (
            <button key={s} type="button" className={status === s ? 'seg on' : 'seg'} onClick={() => set({ status: s })}>
              {STATUS_META[s].label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Priority</span>
        <div className="segmented">
          {PRIORITIES.map(p => (
            <button key={p} type="button" className={priority === p ? 'seg on' : 'seg'} onClick={() => set({ priority: p })} style={priority === p ? { color: PRIORITY_META[p].color } : undefined}>
              {PRIORITY_META[p].label}
            </button>
          ))}
        </div>
      </div>

      {candidates.length > 0 && (
        <label className="field">
          <span>
            Blocked by <small>(unblocks itself when they're done)</small>
          </span>
          <select
            value=""
            onChange={e => {
              const id = e.target.value
              if (id && !blockedBy.includes(id)) {
                set(f => ({ blockedBy: [...f.blockedBy, id] }))
                if (status === 'todo') set({ status: 'blocked' })
              }
            }}
          >
            <option value="">Add a blocker…</option>
            {candidates
              .filter(c => c.id !== taskId && !blockedBy.includes(c.id))
              .map(c => (
                <option key={c.id} value={c.id}>
                  {c.title || 'Untitled'}
                </option>
              ))}
          </select>
          {blockedBy.length > 0 && (
            <span className="chips blockers">
              {blockedBy.map(id => {
                const c = candidates.find(x => x.id === id)
                return (
                  <button key={id} type="button" className="toggle on" onClick={() => set(f => ({ blockedBy: f.blockedBy.filter(x => x !== id) }))} title="Remove blocker">
                    {c?.status === 'done' ? '✓ ' : '⏳ '}
                    {c?.title ?? 'Unknown task'} ✕
                  </button>
                )
              })}
            </span>
          )}
        </label>
      )}
    </>
  )
}
