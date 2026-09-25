import { billEmoji, formatMoney } from '../../bills'
import { daysBetween, type MoneyRow } from '../../finance'
import { RECURRENCE_META, type Bill, type Task } from '../../types'
import { isDayKey } from '../../../shared/weeks.mts'
import { chipOf, moneyName } from './labels'
import { MoneyMeta, NextDate } from './NextDate'

// The money rows Finance draws in more than one place: an occurrence on its
// day (a pay period's rows), one with no date yet (Needs a date, first on the
// main view and in Manage's lists), and a series as Manage lists it. A tap on
// any of them opens its short sheet; Finance decides which (Finance.tsx).

/** "Overdue", "Today", "Tomorrow": how near a day is, or nothing past tomorrow. */
export function soonWord(due: string, today: string, overdue: boolean): string {
  return overdue ? 'Overdue' : due === today ? 'Today' : daysBetween(today, due) === 1 ? 'Tomorrow' : ''
}

/**
 * One bill, payday or set-aside on its day: the day, what it is, how much, and
 * the control that settles it. One its repeat brings is expected, not a task:
 * lighter, with nothing to tick until it is the open one. One dated on or
 * before the check-in is still listed while it is open, and says the balance
 * has it.
 */
export function ComingRow({ row, today, whose, onOpen, onMarkPaid }: { row: MoneyRow; today: string; whose: string | null; onOpen(t: Task): void; onMarkPaid(t: Task): void }) {
  const t = row.task
  const name = moneyName(t, whose)
  const chip = chipOf(row.due)
  const soon = soonWord(row.due, today, row.overdue)
  const status = row.projected ? (row.due < today ? 'Expected by now' : 'Expected') : row.inBalance ? 'In the balance' : ''
  const byName = row.income && whose && !name.startsWith(whose) ? whose : ''
  const meta = [soon, status, byName, t.bill.payee, row.saving ? 'Into savings' : ''].filter(Boolean).join(' · ')
  const amount = row.amount === undefined ? '—' : row.income ? `+${formatMoney(row.amount)}` : formatMoney(row.amount)
  const verb = row.income ? 'Got it' : row.saving ? 'Saved' : 'Paid'
  const what = row.income ? 'received' : row.saving ? 'set aside' : 'paid'
  return (
    <li className={['bill-row', 'fin-row', row.overdue ? 'overdue' : '', row.income ? 'income' : '', row.projected ? 'projected' : ''].filter(Boolean).join(' ')}>
      <button type="button" className="bill-main" onClick={() => onOpen(t)}>
        <span className="fin-date">
          <small>{chip.weekday}</small> <strong>{chip.day}</strong>
        </span>{' '}
        <span className="bill-copy">
          <strong>
            <span aria-hidden="true">{billEmoji(t.bill)}</span> {name}
          </strong>{' '}
          {(meta || t.bill.autopay) && (
            <small>
              {meta}
              {t.bill.autopay && <span className={meta ? 'fin-tag' : 'fin-tag alone'}>Autopay</span>}
            </small>
          )}
        </span>{' '}
        <span className={row.amount === undefined ? 'bill-amount none' : row.income ? 'bill-amount in' : row.saving ? 'bill-amount kept' : 'bill-amount'}>{amount}</span>
      </button>
      {!row.projected && (
        <button type="button" className="btn subtle bill-pay" onClick={() => onMarkPaid(t)} aria-label={`Mark ${name} ${what}`}>
          {verb}
        </button>
      )}
    </li>
  )
}

/**
 * One with no date, under Needs a date: what it is and how much, and a date
 * field that gives it one (local midnight, as + Bill writes a due day). It is
 * written once the field holds a whole date near today: a year typed a digit
 * at a time goes through 0002 and 0202 on its way to 2026.
 */
export function UndatedRow({ task: t, today, whose, onOpen, onDate }: { task: Task & { bill: Bill }; today: string; whose: string | null; onOpen(t: Task): void; onDate(t: Task, day: string): void }) {
  const name = moneyName(t, whose)
  const income = t.bill.kind === 'income'
  const saving = t.bill.kind === 'saving'
  const amount = t.estimateCost === undefined ? '—' : income ? `+${formatMoney(t.estimateCost)}` : formatMoney(t.estimateCost)
  const meta = [t.recurrence ? RECURRENCE_META[t.recurrence.freq] : 'Once', income && whose && !name.startsWith(whose) ? whose : '', 'Not counted'].filter(Boolean).join(' · ')
  const pick = (day: string) => {
    if (isDayKey(day) && Math.abs(daysBetween(today, day)) <= 800) onDate(t, day)
  }
  return (
    <li className={['bill-row', 'fin-row', 'undated', income ? 'income' : ''].filter(Boolean).join(' ')}>
      <button type="button" className="bill-main" onClick={() => onOpen(t)}>
        <span className="bill-copy">
          <strong>
            <span aria-hidden="true">{billEmoji(t.bill)}</span> {name}
          </strong>{' '}
          <small>{meta}</small>
        </span>{' '}
        <span className={t.estimateCost === undefined ? 'bill-amount none' : income ? 'bill-amount in' : saving ? 'bill-amount kept' : 'bill-amount'}>{amount}</span>
      </button>
      <label className="fin-undated-date">
        <span aria-hidden="true">Next date</span>
        <input type="date" className="fin-date-input" aria-label={`${name}: next date`} onChange={e => pick(e.target.value)} />
      </label>
    </li>
  )
}

/**
 * A bill or a payday as Manage lists it: one row a series, its next date
 * first ("Next: Fri, Sep 25", or No date yet in the warning ink), whose pay
 * it is, who is paid, how often and whether it goes by itself, then the
 * amount. A tap opens its short sheet.
 */
export function SeriesRow({ task: t, whose, archived = false, onOpen }: { task: Task & { bill: Bill }; whose: string | null; archived?: boolean; onOpen(t: Task): void }) {
  const income = t.bill.kind === 'income'
  const name = moneyName(t, whose)
  const rest = [income ? whose : '', t.bill.payee, t.recurrence ? RECURRENCE_META[t.recurrence.freq] : 'Once', t.bill.autopay ? 'Autopay' : ''].filter(Boolean).join(' · ')
  const amount = t.estimateCost === undefined ? '—' : income ? `+${formatMoney(t.estimateCost)}` : formatMoney(t.estimateCost)
  return (
    <li className={archived ? 'bill-row fin-item archived' : 'bill-row fin-item'}>
      <button type="button" className="bill-main" onClick={() => onOpen(t)}>
        <span className="bill-glyph" aria-hidden="true">
          {billEmoji(t.bill)}
        </span>
        <span className="bill-copy">
          <strong>{name}</strong>
          <MoneyMeta when={archived ? <span className="fin-next">Archived</span> : <NextDate dueAt={t.dueAt} />} rest={rest} />
        </span>
        <span className={t.estimateCost === undefined ? 'bill-amount none' : income ? 'bill-amount in' : t.bill.kind === 'saving' ? 'bill-amount kept' : 'bill-amount'}>{amount}</span>
      </button>
    </li>
  )
}
