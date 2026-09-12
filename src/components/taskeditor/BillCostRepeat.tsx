import { SetForm, TaskForm } from '../../taskform'
import { BILL_KINDS, BILL_KIND_META, Bill, RECURRENCE_META, RecurrenceFreq } from '../../types'

interface Props {
  form: Pick<TaskForm, 'bill' | 'freq' | 'estimateCost' | 'actualCost'>
  set: SetForm
}

/** Whether this is a bill, what it costs (or cost), and whether it repeats. */
export function BillCostRepeat({ form, set }: Props) {
  const { bill, freq, estimateCost, actualCost } = form
  return (
    <>
      <div className="field bill-field">
        <label className="field-inline">
          <input
            type="checkbox"
            checked={!!bill}
            onChange={e => {
              if (e.target.checked) {
                set({ bill: { kind: 'bill' } })
                // a bill almost always comes round again
                if (!freq) set({ freq: 'monthly' })
              } else set({ bill: undefined })
            }}
          />
          <span>This is a bill or payment</span>
        </label>
        {bill && (
          <div className="bill-fields">
            <select value={bill.kind} onChange={e => set({ bill: { ...bill, kind: e.target.value as Bill['kind'] } })} aria-label="Kind of payment">
              {BILL_KINDS.map(k => (
                <option key={k} value={k}>
                  {BILL_KIND_META[k].emoji} {BILL_KIND_META[k].label}
                </option>
              ))}
            </select>
            <input value={bill.payee ?? ''} onChange={e => set({ bill: { ...bill, payee: e.target.value } })} placeholder="Paid to (optional)" aria-label="Paid to" />
            <label className="field-inline">
              <input type="checkbox" checked={!!bill.autopay} onChange={e => set({ bill: { ...bill, autopay: e.target.checked || undefined } })} />
              <span>Paid automatically</span>
            </label>
          </div>
        )}
      </div>

      <div className="field-row costs">
        <label className="field">
          <span>{bill ? 'Amount due' : 'Estimate'}</span>
          <input inputMode="decimal" value={estimateCost} onChange={e => set({ estimateCost: e.target.value })} placeholder="0" />
        </label>
        <label className="field">
          <span>{bill ? 'Paid' : 'Actual cost'}</span>
          <input inputMode="decimal" value={actualCost} onChange={e => set({ actualCost: e.target.value })} placeholder="0" />
        </label>
      </div>

      <label className="field">
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
    </>
  )
}
