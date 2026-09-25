import { useId } from 'react'
import { SetForm, TaskForm } from '../../taskform'
import { dateKey, toLocalInput } from '../../utils'
import { isDayKey } from '../../../shared/weeks.mts'

interface Props {
  form: Pick<TaskForm, 'dueAt' | 'completedAt' | 'status' | 'bill'>
  set: SetForm
}

/**
 * When it's due (with one-tap chips) and, once done, when it was finished.
 *
 * Money — a bill, a payday or a set-aside — falls due on a day, not at a
 * time, so it takes a date alone, kept as local midnight: the day with no
 * time that + Bill writes (localMidnightIso) and that every due date reads.
 * A date-and-time field picked for its date alone can be left holding no
 * value at all on an iPhone, and paydays saved that way were counted nowhere.
 * One with no date says what that costs.
 */
export function DueFields({ form, set }: Props) {
  const { dueAt, completedAt, status, bill } = form
  const id = useId()
  const hintId = `${id}-hint`
  const labelId = `${id}-label`
  const undated = !!bill && !dueAt

  function setDueChip(d: Date | null) {
    set({ dueAt: d ? toLocalInput(d.toISOString()) : '' })
  }
  /** A day picked for money: its local midnight, in the field's own datetime-local form (fromLocalInput reads it back). */
  const setDay = (key: string) => set({ dueAt: isDayKey(key) ? `${key}T00:00` : '' })

  const completed = status === 'done' && (
    <label className="field">
      <span>Completed</span>
      <input type="datetime-local" value={completedAt} onChange={e => set({ completedAt: e.target.value })} />
    </label>
  )

  if (bill) {
    // named by its heading alone: the chips under it are buttons of their own, not part of a label
    return (
      <>
        <div className="field">
          <span id={labelId}>{bill.kind === 'income' ? 'Next payday' : 'Next due'}</span>
          <input
            type="date"
            className="due-date-input"
            value={dueAt.slice(0, 10)}
            onChange={e => setDay(e.target.value)}
            aria-labelledby={labelId}
            aria-describedby={undated ? hintId : undefined}
          />
          <div className="due-chips">
            <button type="button" className="btn subtle" onClick={() => setDay(dateKey(new Date()))}>
              Today
            </button>
            <button
              type="button"
              className="btn subtle"
              onClick={() => {
                const d = new Date()
                d.setDate(d.getDate() + 1)
                setDay(dateKey(d))
              }}
            >
              Tomorrow
            </button>
            <button type="button" className="btn subtle" onClick={() => setDay('')}>
              Clear
            </button>
          </div>
        </div>
        {undated && (
          <p id={hintId} className="field-hint due-money-hint">
            Add a date so Finance can count it.
          </p>
        )}
        {completed}
      </>
    )
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

      {completed}
    </>
  )
}
