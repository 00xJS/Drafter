import { SetForm, TaskForm } from '../../taskform'
import { BILL_KINDS, BILL_KIND_META, Bill } from '../../types'

interface Props {
  form: Pick<TaskForm, 'bill' | 'estimateCost' | 'actualCost'>
  set: SetForm
  /** Costs belong to bills; any other task shows them only while it has a value (costsVisible). */
  showCosts: boolean
}

/** Whether this is a bill, and what it costs (or cost). How often it comes round is the Repeat field, further down. */
export function BillCost({ form, set, showCosts }: Props) {
  const { bill, estimateCost, actualCost } = form
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
                set(f => (f.freq ? {} : { freq: 'monthly' }))
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

      {showCosts && (
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
      )}
    </>
  )
}
