import { SetForm, TaskForm } from '../../taskform'
import { BILL_KINDS, BILL_KIND_META, Bill } from '../../types'

interface Props {
  form: Pick<TaskForm, 'bill' | 'estimateCost' | 'actualCost'>
  set: SetForm
  /** Costs belong to bills; any other task shows them only while it has a value (costsVisible). */
  showCosts: boolean
  /** The household, so a payday can say whose it is (v3.27). Empty alone. */
  members?: { id: string; displayName: string }[]
}

/**
 * Whether this is a payment, which way the money goes, and how much. How often
 * it comes round is the Repeat field, further down.
 *
 * A payday is the same facet with `kind: 'income'` (v3.27): the same payer,
 * amount, repeat and date, so it lands on the calendar and in the reminders
 * with nothing new behind it. The only field it adds is whose it is, because
 * two people are paid on different days.
 */
export function BillCost({ form, set, showCosts, members = [] }: Props) {
  const { bill, estimateCost, actualCost } = form
  const income = bill?.kind === 'income'
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
          <span>This is money in or out</span>
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
            <input
              value={bill.payee ?? ''}
              onChange={e => set({ bill: { ...bill, payee: e.target.value } })}
              placeholder={income ? 'Paid by (optional)' : 'Paid to (optional)'}
              aria-label={income ? 'Paid by' : 'Paid to'}
            />
            {income && members.length > 1 && (
              <select
                value={bill.forMemberId ?? ''}
                aria-label="Whose payday"
                onChange={e => set({ bill: { ...bill, forMemberId: e.target.value || undefined } })}
              >
                <option value="">Whose payday?</option>
                {members.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            )}
            {!income && (
              <label className="field-inline">
                <input type="checkbox" checked={!!bill.autopay} onChange={e => set({ bill: { ...bill, autopay: e.target.checked || undefined } })} />
                <span>Paid automatically</span>
              </label>
            )}
          </div>
        )}
      </div>

      {showCosts && (
        <div className="field-row costs">
          <label className="field">
            <span>{income ? 'Amount paid in' : bill ? 'Amount due' : 'Estimate'}</span>
            <input inputMode="decimal" value={estimateCost} onChange={e => set({ estimateCost: e.target.value })} placeholder="$0" />
          </label>
          <label className="field">
            <span>{income ? 'Actually received' : bill ? 'Paid' : 'Actual cost'}</span>
            <input inputMode="decimal" value={actualCost} onChange={e => set({ actualCost: e.target.value })} placeholder="$0" />
          </label>
        </div>
      )}
    </>
  )
}
