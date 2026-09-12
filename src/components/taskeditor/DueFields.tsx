import { SetForm, TaskForm } from '../../taskform'
import { toLocalInput } from '../../utils'

interface Props {
  form: Pick<TaskForm, 'dueAt' | 'completedAt' | 'status'>
  set: SetForm
}

/** When it's due (with one-tap chips) and, once done, when it was finished. */
export function DueFields({ form, set }: Props) {
  const { dueAt, completedAt, status } = form

  function setDueChip(d: Date | null) {
    set({ dueAt: d ? toLocalInput(d.toISOString()) : '' })
  }

  return (
    <>
      <label className="field">
        <span>Due</span>
        <input type="datetime-local" value={dueAt} onChange={e => set({ dueAt: e.target.value })} />
        <div className="due-chips">
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              const d = new Date()
              d.setHours(18, 0, 0, 0)
              setDueChip(d)
            }}
          >
            Today 18:00
          </button>
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              const d = new Date()
              d.setDate(d.getDate() + 1)
              d.setHours(9, 0, 0, 0)
              setDueChip(d)
            }}
          >
            Tomorrow 09:00
          </button>
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              const d = new Date()
              const delta = (6 - d.getDay() + 7) % 7 || 7
              d.setDate(d.getDate() + delta)
              d.setHours(10, 0, 0, 0)
              setDueChip(d)
            }}
          >
            Weekend
          </button>
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              const d = new Date()
              const delta = (1 - d.getDay() + 7) % 7 || 7
              d.setDate(d.getDate() + delta)
              d.setHours(9, 0, 0, 0)
              setDueChip(d)
            }}
          >
            Next Monday
          </button>
          <button type="button" className="btn subtle" onClick={() => setDueChip(null)}>
            Clear
          </button>
        </div>
      </label>

      {status === 'done' && (
        <label className="field">
          <span>Completed</span>
          <input type="datetime-local" value={completedAt} onChange={e => set({ completedAt: e.target.value })} />
        </label>
      )}
    </>
  )
}
