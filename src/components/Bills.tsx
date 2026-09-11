import { useMemo, useState } from 'react'
import { BILL_KIND_META, RECURRENCE_META, Task } from '../types'
import { billMonth, formatMoney, isBill, monthlyCost } from '../bills'

// The household's payments, one month at a time: what is overdue, what is
// still to come, what has been paid, and what an average month costs. Every
// row is a task, so it is also on the calendar, in reminders and on Today.

const fmtDay = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')

type RowState = 'overdue' | 'upcoming' | 'paid'

export function Bills({
  tasks,
  onOpen,
  onNew,
  onMarkPaid,
}: {
  tasks: Task[]
  onOpen(t: Task): void
  /** Open the task editor on a new bill. */
  onNew(): void
  onMarkPaid(t: Task): void
}) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const month = useMemo(() => billMonth(tasks, cursor), [tasks, cursor])
  const perMonth = useMemo(() => monthlyCost(tasks), [tasks])
  const any = useMemo(() => tasks.some(isBill), [tasks])
  const monthName = cursor.toLocaleDateString(undefined, { month: 'long' })
  const shift = (n: number) => setCursor(c => new Date(c.getFullYear(), c.getMonth() + n, 1))

  const row = (t: Task, state: RowState) => {
    const kind = t.bill ? BILL_KIND_META[t.bill.kind] : BILL_KIND_META.bill
    const when = state === 'paid' ? `Paid ${fmtDay(t.completedAt)}` : `Due ${fmtDay(t.dueAt)}`
    // A paid occurrence hands its repeat on to next month's copy, so naming a
    // frequency on it would read "One-off" for a bill that is anything but.
    const cadence = state === 'paid' ? '' : t.recurrence ? RECURRENCE_META[t.recurrence.freq] : 'One-off'
    const meta = [t.bill?.payee, when, cadence, t.bill?.autopay ? 'Autopay' : '']
      .filter(Boolean)
      .join(' · ')
    return (
      <li key={t.id} className={'bill-row ' + state}>
        <button type="button" className="bill-main" onClick={() => onOpen(t)}>
          <span className="bill-glyph" aria-hidden>
            {kind.emoji}
          </span>
          <span className="bill-copy">
            <strong>{t.title || 'Untitled bill'}</strong>
            <small>{meta}</small>
          </span>
          <span className="bill-amount">{formatMoney(state === 'paid' ? (t.actualCost ?? t.estimateCost) : t.estimateCost)}</span>
        </button>
        {state !== 'paid' && (
          <button type="button" className="btn subtle bill-pay" onClick={() => onMarkPaid(t)} aria-label={`Mark ${t.title || 'bill'} paid`}>
            Paid
          </button>
        )}
      </li>
    )
  }

  return (
    <div className="bills">
      <div className="people-toolbar">
        <h2>Bills</h2>
        <button className="btn" onClick={() => shift(-1)} aria-label="Previous month">
          ‹
        </button>
        <span className="bills-month">{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="btn" onClick={() => shift(1)} aria-label="Next month">
          ›
        </button>
        <button className="btn primary" onClick={onNew}>
          + Bill
        </button>
      </div>

      {!any ? (
        <p className="empty">
          Add the bills, cards and subscriptions you pay. Each one sits on its due date in the calendar, reminds you like any task, and repeats monthly, quarterly or yearly. Marking one paid records what it cost.
        </p>
      ) : (
        <>
          <div className="kpi-row bills-kpis">
            <div className="stat-tile">
              <span className="stat-label">Still to pay</span>
              <span className="stat-value">{formatMoney(month.stillToPay)}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">Paid in {monthName}</span>
              <span className="stat-value">{formatMoney(month.paidSoFar)}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">An average month</span>
              <span className="stat-value">{formatMoney(perMonth)}</span>
              <span className="stat-sub">every repeating payment</span>
            </div>
          </div>

          {month.overdue.length > 0 && (
            <section>
              <h3 className="bills-head overdue">Overdue</h3>
              <ul className="bill-list">{month.overdue.map(t => row(t, 'overdue'))}</ul>
            </section>
          )}

          <section>
            <h3 className="bills-head">Due in {monthName}</h3>
            {month.upcoming.length > 0 ? <ul className="bill-list">{month.upcoming.map(t => row(t, 'upcoming'))}</ul> : <p className="muted">Nothing else due in {monthName}.</p>}
          </section>

          {month.paid.length > 0 && (
            <section>
              <h3 className="bills-head">Paid</h3>
              <ul className="bill-list">{month.paid.map(t => row(t, 'paid'))}</ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
