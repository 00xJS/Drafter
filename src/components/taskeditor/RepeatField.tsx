import { SetForm, TaskForm } from '../../taskform'
import { RECURRENCE_META, RecurrenceFreq } from '../../types'

interface Props {
  freq: TaskForm['freq']
  set: SetForm
}

/** Whether the task comes round again — bills included (ticking "This is a bill" starts it at monthly). */
export function RepeatField({ freq, set }: Props) {
  return (
    <label className="field repeat-field">
      <span>Repeat</span>
      <select value={freq} onChange={e => set({ freq: e.target.value as RecurrenceFreq | '' })}>
        <option value="">Doesn't repeat</option>
        {(Object.keys(RECURRENCE_META) as RecurrenceFreq[]).map(f => (
          <option key={f} value={f}>
            {RECURRENCE_META[f]}
          </option>
        ))}
      </select>
      {freq && <small className="field-hint">When this is marked done, the next occurrence is created automatically.</small>}
    </label>
  )
}
