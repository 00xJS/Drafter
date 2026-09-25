import { useId } from 'react'
import { SetForm, TaskForm, dayOf, joinLocal, timeOf } from '../../taskform'
import { clockAt, dateKey, toLocalInput } from '../../utils'
import { isDayKey } from '../../../shared/weeks.mts'

interface Props {
  form: Pick<TaskForm, 'dueAt' | 'completedAt' | 'status' | 'bill'>
  set: SetForm
  /** Logging something already done: when it was done comes first, and the due chips, which look ahead, are left out. */
  logged?: boolean
}

/**
 * A day, and a time if it has one: a date field and a time field, where one
 * date-and-time field was. On an iPhone that one could be left holding no
 * value at all when only its date was picked. The day alone is kept as local
 * midnight (joinLocal), which every due date reads as a day with no time.
 */
export function WhenFields({ value, onChange, labelId, timeLabel }: { value: string; onChange(local: string): void; labelId: string; timeLabel: string }) {
  return (
    <div className="when-row">
      <input
        type="date"
        className="when-date"
        value={dayOf(value)}
        aria-labelledby={labelId}
        // cleared, the day takes its time with it
        onChange={e => onChange(e.target.value ? joinLocal(e.target.value, timeOf(value), '') : '')}
      />
      <input type="time" className="when-time" value={timeOf(value)} aria-label={timeLabel} onChange={e => onChange(joinLocal(dayOf(value), e.target.value, dateKey(new Date())))} />
    </div>
  )
}

/** A due chip: a day from now, at an hour, said the way the app says times (6pm, 9am). */
const CHIPS: { label: string; at(now: Date): Date }[] = [
  { label: `Today ${clockAt(18)}`, at: now => atHour(now, 0, 18) },
  { label: `Tomorrow ${clockAt(9)}`, at: now => atHour(now, 1, 9) },
  { label: 'Weekend', at: now => atHour(now, (6 - now.getDay() + 7) % 7 || 7, 10) },
  { label: 'Next Monday', at: now => atHour(now, (1 - now.getDay() + 7) % 7 || 7, 9) },
]

function atHour(now: Date, days: number, hour: number): Date {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  d.setHours(hour, 0, 0, 0)
  return d
}

/**
 * When it's due (with one-tap chips that set the day and the time) and, once
 * done, when it was finished.
 *
 * Money — a bill, a payday or a set-aside — falls due on a day, not at a
 * time, so it takes a date alone, kept as local midnight: the day with no
 * time that + Bill writes (localMidnightIso) and that every due date reads.
 * One with no date says what that costs.
 */
export function DueFields({ form, set, logged = false }: Props) {
  const { dueAt, completedAt, status, bill } = form
  const id = useId()
  const hintId = `${id}-hint`
  const labelId = `${id}-label`
  const doneId = `${id}-done`
  const undated = !!bill && !dueAt

  /** A day picked for money: its local midnight, in the field's own datetime-local form (fromLocalInput reads it back). */
  const setDay = (key: string) => set({ dueAt: isDayKey(key) ? `${key}T00:00` : '' })

  const completed = status === 'done' && (
    <div className="field">
      <span id={doneId}>Completed</span>
      <WhenFields value={completedAt} onChange={v => set({ completedAt: v })} labelId={doneId} timeLabel="Completed time" />
    </div>
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

  const due = (
    <div className="field">
      <span id={labelId}>Due</span>
      <WhenFields value={dueAt} onChange={v => set({ dueAt: v })} labelId={labelId} timeLabel="Due time" />
      {!logged && (
        <div className="due-chips">
          {CHIPS.map(c => (
            <button key={c.label} type="button" className="btn subtle" onClick={() => set({ dueAt: toLocalInput(c.at(new Date()).toISOString()) })}>
              {c.label}
            </button>
          ))}
          <button type="button" className="btn subtle" onClick={() => set({ dueAt: '' })}>
            Clear
          </button>
        </div>
      )}
    </div>
  )

  return logged ? (
    <>
      {completed}
      {due}
    </>
  ) : (
    <>
      {due}
      {completed}
    </>
  )
}
