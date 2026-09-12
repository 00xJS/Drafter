import { SetForm, TaskForm } from '../../taskform'
import { PRIORITIES, PRIORITY_META, STATUS_META, Task, pickerStatuses } from '../../types'

interface Props {
  form: Pick<TaskForm, 'assigneeId' | 'status' | 'priority' | 'blockedBy'>
  set: SetForm
  /** Household members (empty when not in a household). */
  members: { id: string; displayName: string }[]
  /** Open tasks that could block this one. */
  candidates: Task[]
  /** This task's own id, never offered as its own blocker. */
  taskId: string
}

/**
 * Who's doing it, status, priority and blockers. There is no project picker:
 * there is one home project, a new task takes one only from a preset, template
 * or Draft a plan, and a saved task keeps its own.
 */
export function AssignFields({ form, set, members, candidates, taskId }: Props) {
  const { assigneeId, status, priority, blockedBy } = form
  return (
    <>
      {members.length > 1 && (
        <label className="field">
          <span>Who's doing it</span>
          <select value={assigneeId} onChange={e => set({ assigneeId: e.target.value })}>
            <option value="">Anyone</option>
            {members.map(m => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
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
