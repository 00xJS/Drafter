import { useState } from 'react'
import { SetForm, TaskForm, money } from '../../taskform'
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
 *
 * A set-aside (`kind: 'saving'`) is the facet once more, for money moved into
 * savings on a schedule. What it adds is the goal: how much, and by when.
 */
export function BillCost({ form, set, showCosts, members = [] }: Props) {
  const { bill, estimateCost, actualCost } = form
  const income = bill?.kind === 'income'
  const saving = bill?.kind === 'saving'
  // the goal's amount as typed: "5,0" on its way to "5,000" is not a number yet
  const [target, setTarget] = useState(() => (bill?.goal?.target ? String(bill.goal.target) : ''))
  const setGoal = (b: Bill, next: { target?: string; by?: string }) => {
    const text = next.target ?? target
    const by = next.by !== undefined ? next.by || undefined : b.goal?.by
    const amount = money(text) ?? 0
    // kept while either half is filled in, so a date picked first is not lost;
    // one with no amount over nothing is dropped as the task is saved (schema.ts)
    set({ bill: { ...b, goal: amount > 0 || by ? { target: amount, ...(by ? { by } : {}) } : undefined } })
  }
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
            <select
              value={bill.kind}
              onChange={e => {
                const kind = e.target.value as Bill['kind']
                // a goal belongs to a set-aside alone
                set({ bill: { ...bill, kind, goal: kind === 'saving' ? bill.goal : undefined } })
              }}
              aria-label="Kind of payment"
            >
              {BILL_KINDS.map(k => (
                <option key={k} value={k}>
                  {BILL_KIND_META[k].emoji} {BILL_KIND_META[k].label}
                </option>
              ))}
            </select>
            <input
              value={bill.payee ?? ''}
              onChange={e => set({ bill: { ...bill, payee: e.target.value } })}
              placeholder={income ? 'Paid by (optional)' : saving ? 'Into (optional)' : 'Paid to (optional)'}
              aria-label={income ? 'Paid by' : saving ? 'Set aside into' : 'Paid to'}
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
                <span>{saving ? 'Moved automatically' : 'Paid automatically'}</span>
              </label>
            )}
            {saving && (
              <>
                <label className="field">
                  <span>Saving towards</span>
                  <input
                    inputMode="decimal"
                    value={target}
                    placeholder="$0"
                    onChange={e => {
                      setTarget(e.target.value)
                      setGoal(bill, { target: e.target.value })
                    }}
                  />
                </label>
                <label className="field">
                  <span>By (optional)</span>
                  <input type="date" value={bill.goal?.by ?? ''} onChange={e => setGoal(bill, { by: e.target.value })} />
                </label>
              </>
            )}
          </div>
        )}
      </div>

      {showCosts && (
        <div className="field-row costs">
          <label className="field">
            <span>{income ? 'Amount paid in' : saving ? 'Set aside each time' : bill ? 'Amount due' : 'Estimate'}</span>
            <input inputMode="decimal" value={estimateCost} onChange={e => set({ estimateCost: e.target.value })} placeholder="$0" />
          </label>
          <label className="field">
            <span>{income ? 'Actually received' : saving ? 'Actually set aside' : bill ? 'Paid' : 'Actual cost'}</span>
            <input inputMode="decimal" value={actualCost} onChange={e => set({ actualCost: e.target.value })} placeholder="$0" />
          </label>
        </div>
      )}
    </>
  )
}
