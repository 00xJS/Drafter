import { useId, useMemo, useState } from 'react'
import { SetForm, TaskForm } from '../../taskform'
import { OPEN_STATUSES, PRIORITIES, PRIORITY_META, STATUS_META, Task, pickerStatuses } from '../../types'

/** The most tasks the Blocked by list holds at once; past it, a box finds the rest by name. */
export const BLOCKER_OPTIONS_MAX = 50

/**
 * What the Blocked by list offers: the open tasks (to do, doing, blocked) that
 * are not this one and not already among its blockers, whose title holds
 * `query` — the most recently changed first, BLOCKER_OPTIONS_MAX of them — and
 * how many more there are. A household's whole list, one option per task,
 * rebuilt as each letter was typed anywhere in the editor, was more than a
 * phone's picker wheel or anyone scrolling it needs.
 */
export function blockerOptions(candidates: readonly Task[], taskId: string, blockedBy: readonly string[], query = ''): { options: Task[]; more: number } {
  const q = query.trim().toLowerCase()
  const open = candidates.filter(
    c => c.id !== taskId && OPEN_STATUSES.includes(c.status) && !blockedBy.includes(c.id) && (!q || (c.title || 'Untitled').toLowerCase().includes(q)),
  )
  open.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
  return { options: open.slice(0, BLOCKER_OPTIONS_MAX), more: Math.max(0, open.length - BLOCKER_OPTIONS_MAX) }
}

interface Props {
  form: Pick<TaskForm, 'assigneeId' | 'status' | 'priority' | 'blockedBy' | 'shared'>
  set: SetForm
  /** Household members (empty when not in a household). */
  members: { id: string; displayName: string }[]
  /** Open tasks that could block this one, and those it already waits on, so their chips have names. */
  candidates: Task[]
  /** This task's own id, never offered as its own blocker. */
  taskId: string
  /** The reader's own account id, so "assigned to someone else" can be told from "assigned to me". */
  myId?: string | null
  /** Whose task this is. A peer's is theirs to withhold, not yours. */
  ownerId?: string | null
  /** New-task essentials: who it's for and who can see it. Status, priority
   *  and blockers wait behind More details. */
  essentials?: boolean
}

/**
 * Who's doing it, status, priority and blockers. There is no project picker:
 * there is one home project, a new task takes one only from a preset, template
 * or Draft a plan, and a saved task keeps its own.
 */
export function AssignFields({ form, set, members, candidates, taskId, myId, ownerId, essentials = false }: Props) {
  const { assigneeId, status, priority, blockedBy, shared } = form
  // Whose job it is and who can see it are different questions, but one answer
  // rules out the other: a task the other member is meant to do cannot be kept
  // from them. Said and refused here rather than allowed and then undone by
  // the server, which would look like the app losing an edit.
  //
  // The assignee has to still BE a member for that to hold. One who has left
  // the household is nobody, and locking the control against a name that is
  // not on the list any more left a task that could never be made private.
  const theirs = !!assigneeId && !!myId && assigneeId !== myId && members.some(m => m.id === assigneeId)
  const assignee = theirs ? members.find(m => m.id === assigneeId)?.displayName : undefined
  // Only the owner decides, and the database agrees: the `with check` half of
  // the posts policy refuses a peer's write that withholds a row, so a button
  // here would be a lie the server refuses — the task would sit dirty, retried
  // for good, wearing a private badge nobody else could see. A peer's task
  // says whose it is instead, exactly as a peer's note does.
  const mine = !ownerId || !myId || ownerId === myId
  const owner = mine ? undefined : members.find(m => m.id === ownerId)?.displayName
  // The blocker list is drawn again only when what it lists could change. The
  // editor above renders this on every keystroke in any of its fields.
  const [find, setFind] = useState('')
  const offered = useMemo(() => blockerOptions(candidates, taskId, blockedBy, find), [candidates, taskId, blockedBy, find])
  const blockerOptionEls = useMemo(
    () =>
      offered.options.map(c => (
        <option key={c.id} value={c.id}>
          {c.title || 'Untitled'}
        </option>
      )),
    [offered],
  )
  const blockerSelect = useId()
  return (
    <>
      {members.length > 1 && (
        <label className="field">
          <span>Who's doing it</span>
          <select
            value={assigneeId}
            onChange={e => {
              // handing it to the other member shares it: they cannot do a task they cannot see.
              // Whoever changes it is who handed it over, and hears how it goes (notify.mjs)
              const id = e.target.value
              const by = { assignedBy: myId ?? '' }
              set(myId && id && id !== myId ? { assigneeId: id, shared: true, ...by } : { assigneeId: id, ...by })
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
          {mine ? (
            <>
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
                    : 'Only you can see this task — share it to put it on their list, board and calendar.'}
              </small>
            </>
          ) : (
            // said, not offered — the words on the screen are the accessible
            // ones, so there is no aria-label and no tip to go with them
            <small className="muted">
              <span aria-hidden="true">👥</span> {owner ? `${owner}’s task` : 'Someone else’s task'} — only {owner ?? 'they'} can keep it to themselves.
            </small>
          )}
        </div>
      )}

      {!essentials && (
        <>
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
        <label className="field" htmlFor={blockerSelect}>
          <span>
            Blocked by <small>(unblocks itself when they're done)</small>
          </span>
          {(find || offered.more > 0) && (
            <input type="search" value={find} onChange={e => setFind(e.target.value)} placeholder="Find a task…" aria-label="Find a task that blocks this one" />
          )}
          <select
            id={blockerSelect}
            value=""
            onChange={e => {
              const id = e.target.value
              if (id && !blockedBy.includes(id)) {
                set(f => ({ blockedBy: [...f.blockedBy, id] }))
                if (status === 'todo') set({ status: 'blocked' })
              }
            }}
          >
            <option value="">{find && offered.options.length === 0 ? 'No open task by that name' : 'Add a blocker…'}</option>
            {blockerOptionEls}
            {offered.more > 0 && (
              <option value="" disabled>
                {`…and ${offered.more} more — find them by name above`}
              </option>
            )}
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
      )}
    </>
  )
}
