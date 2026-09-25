import { useMemo, useState } from 'react'
import { formatMoney, isBill, isPayday, isSaving, monthlyCost, monthlyIncome, monthlySetAside, monthlySpare } from '../../bills'
import { CHECK_IN_DEFAULT, accountGroups, accountKindLabel, isLiability, latestBalance, moneySeries, moneyTotals, openCheckIn, savingGoals, slotOf, type AccountGroupKey } from '../../finance'
import type { Account, Bill, Task } from '../../types'
import { Bills } from '../Bills'
import { Segmented } from '../stats/Segmented'
import { GoalCard } from './Goals'
import { AccountMark } from './KindMark'
import { WEEKDAYS, ageOf } from './labels'
import { SeriesRow, UndatedRow } from './Rows'

// Manage: everything Finance keeps that is not today's picture. The bills and
// the paydays as lists, soonest first, each opening its short sheet; the
// month of bills with what was paid; the accounts in their groups with the
// totals; the goals; what an average month comes to; and the weekly check-in.
//
// A screen you go into and come back from, drawn as Settings' is: ‹ Back and
// the title in a header that holds still under the top bar (.pushed-head,
// 02-chrome.css), with the notes pad's back control. It is Finance's own
// sub-view, as a project's pad is Notes', so Tasks' segments stay above it
// and a tap on Finance's segment comes back to the pay periods.

export type ManageTab = 'bills' | 'paydays' | 'accounts' | 'goals'
const TABS: { key: ManageTab; label: string }[] = [
  { key: 'bills', label: 'Bills' },
  { key: 'paydays', label: 'Paydays' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'goals', label: 'Goals' },
]

type Member = { id: string; displayName: string }

interface Props {
  tab: ManageTab
  onTab(tab: ManageTab): void
  tasks: Task[]
  accounts: Account[]
  members: Member[]
  myId?: string | null
  today: string
  at: Date
  onBack(): void
  /** A bill's or a payday's short sheet (Finance decides which), or the editor for one already paid. */
  onOpen(t: Task): void
  /** A goal's next set-aside, in the editor. */
  onOpenGoal(t: Task): void
  onMarkPaid(t: Task): void
  onDate(t: Task, day: string): void
  onAddBill(): void
  onAddPayday(): void
  onAddGoal(): void
  onAddAccount(): void
  onAccount(id: string): void
  onCheckIn(): void
  /** The weekly check-in: turned on at a slot, moved to another, or turned off. */
  onCheckInWeekly(slot: { weekday: number; time: string } | null): void
}

export function Manage(props: Props) {
  const { tab, onTab, tasks, onBack } = props
  const month = useMemo(() => ({ in: monthlyIncome(tasks), out: monthlyCost(tasks), spare: monthlySpare(tasks), kept: monthlySetAside(tasks) }), [tasks])
  return (
    <div className="fin-manage-screen">
      <header className="pushed-head fin-manage-head">
        <button type="button" className="btn subtle notes-back" aria-label="Back" title="Back" onClick={onBack}>
          Back
        </button>
        <h2 className="view-title">Manage</h2>
      </header>
      <div className="fin-manage">
        <Segmented items={TABS} value={tab} onChange={onTab} label="Manage" className="fin-manage-seg" />
        {(month.in > 0 || month.out > 0) && (
          <p className="fin-month">
            An average month: {month.in > 0 && <strong>{formatMoney(month.in)} in</strong>}
            {month.in > 0 && ' · '}
            <strong>{formatMoney(month.out)} out</strong>
            {month.in > 0 && (
              <>
                {' · '}
                <strong className={month.spare < 0 ? 'owed' : undefined}>{formatMoney(month.spare)} left over</strong>
                {month.kept > 0 && `, ${formatMoney(month.kept)} of it set aside`}
              </>
            )}
          </p>
        )}
        {tab === 'bills' && <MoneyPane kind="bills" {...props} />}
        {tab === 'paydays' && <MoneyPane kind="paydays" {...props} />}
        {tab === 'accounts' && <AccountsPane {...props} />}
        {tab === 'goals' && <GoalsPane {...props} />}
      </div>
    </div>
  )
}

/** A pane's own bar: what it lists, and its + button. */
function PaneBar({ label, add, onAdd }: { label: string; add: string; onAdd(): void }) {
  return (
    <div className="fin-pane-bar">
      <h3 className="bills-head">{label}</h3>
      <span className="spacer" />
      <button type="button" className="btn primary" onClick={onAdd}>
        {add}
      </button>
    </div>
  )
}

/**
 * The bills, or the paydays: those with no date first, under Needs a date,
 * then every series soonest first, then any archived. The bills keep the
 * month of bills under them, with what was paid in each month.
 */
function MoneyPane({ kind, tasks, members, today, onOpen, onMarkPaid, onDate, onAddBill, onAddPayday }: Props & { kind: 'bills' | 'paydays' }) {
  const bills = kind === 'bills'
  const series = useMemo(() => moneySeries(tasks, bills ? isBill : isPayday), [tasks, bills])
  const nameOf = (id: string | undefined) => (id ? (members.find(m => m.id === id)?.displayName ?? null) : null)
  const whose = (t: Task & { bill: Bill }) => nameOf(t.bill.forMemberId)
  const none = !series.dated.length && !series.undated.length && !series.archived.length
  return (
    <section className="fin-pane" aria-labelledby={`fin-pane-${kind}`}>
      <div className="fin-pane-bar">
        <h3 id={`fin-pane-${kind}`} className="bills-head">
          {bills ? 'Every bill' : 'Every payday'}
        </h3>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={bills ? onAddBill : onAddPayday}>
          {bills ? '+ Bill' : '+ Payday'}
        </button>
      </div>
      {none && (
        <p className="fin-empty">
          {bills
            ? 'Add the bills, cards and subscriptions you pay. Each one sits on its due date in the calendar, reminds you like any task, and comes off what is safe to spend on its day.'
            : 'Add each person’s pay — how much lands, how often and when the next one does. Finance counts every one of them on its day, the way it counts the bills.'}
        </p>
      )}
      {series.undated.length > 0 && (
        <div className="fin-needs" role="group" aria-labelledby={`fin-${kind}-undated`}>
          <h4 id={`fin-${kind}-undated`} className="fin-undated-head">
            Needs a date
          </h4>
          <ul className="bill-list fin-rows">
            {series.undated.map(t => (
              <UndatedRow key={t.id} task={t} today={today} whose={whose(t)} onOpen={onOpen} onDate={onDate} />
            ))}
          </ul>
        </div>
      )}
      {series.dated.length > 0 && (
        <ul className="bill-list fin-list">
          {series.dated.map(t => (
            <SeriesRow key={t.id} task={t} whose={whose(t)} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {series.archived.length > 0 && (
        <div className="fin-archived" role="group" aria-labelledby={`fin-${kind}-archived`}>
          <h4 id={`fin-${kind}-archived`} className="bills-head">
            Archived
          </h4>
          <ul className="bill-list fin-list">
            {series.archived.map(t => (
              <SeriesRow key={t.id} task={t} whose={whose(t)} archived onOpen={onOpen} />
            ))}
          </ul>
        </div>
      )}
      {bills && !none && (
        <div className="fin-month-of" role="group" aria-labelledby="fin-month-of-head">
          <h3 id="fin-month-of-head" className="bills-head">
            Month by month
          </h3>
          <Bills tasks={tasks} onOpen={onOpen} onMarkPaid={onMarkPaid} />
        </div>
      )}
    </section>
  )
}

const GROUP_HINTS: Record<AccountGroupKey, string> = {
  spending: 'Counted in safe to spend',
  savings: 'Kept: not in safe to spend',
  investments: 'In net worth only',
  owed: 'What the cards are owed',
}

/** The accounts in their groups, each with its subtotal, then the totals, the archived ones and the weekly check-in. */
function AccountsPane({ tasks, accounts, members, myId, today, onAccount, onAddAccount, onCheckIn, onCheckInWeekly }: Props) {
  const groups = useMemo(() => accountGroups(accounts), [accounts])
  const totals = useMemo(() => moneyTotals(accounts), [accounts])
  const archived = useMemo(() => accounts.filter(a => !a.deletedAt && !!a.archivedAt), [accounts])
  const weekly = useMemo(() => openCheckIn(tasks, myId), [tasks, myId])
  const nameOf = (id: string | undefined) => (id ? (members.find(m => m.id === id)?.displayName ?? null) : null)
  return (
    <section className="fin-pane" aria-label="Accounts">
      <PaneBar label="Accounts" add="+ Account" onAdd={onAddAccount} />
      {groups.length === 0 && !archived.length ? (
        <p className="fin-empty">
          Add an account and type in what it holds. Drafter never connects to a bank — this is your own note of the balance, on the day it was true, and everything Finance
          works out comes from it and from the bills and paydays you have written down.
        </p>
      ) : (
        <>
          {groups.map(g => (
            <section key={g.key} className={`fin-group ${g.key}`} aria-labelledby={`fin-group-${g.key}`}>
              <div className="fin-group-head">
                <span className="fin-group-copy">
                  <h4 id={`fin-group-${g.key}`} className="bills-head">
                    {g.label}
                  </h4>
                  <small>{GROUP_HINTS[g.key]}</small>
                </span>
                <strong className={g.key === 'owed' && g.total > 0 ? 'owed' : undefined}>{g.checked ? formatMoney(g.total) : '—'}</strong>
              </div>
              <ul className="bill-list fin-list">
                {g.accounts.map(a => (
                  <AccountItem key={a.id} account={a} today={today} whose={nameOf(a.memberId)} onOpen={() => onAccount(a.id)} />
                ))}
              </ul>
            </section>
          ))}
          <ul className="admin-stats finance-totals fin-totals" aria-label="Totals">
            <li className="admin-stat">
              <span>Net worth</span>
              <strong>{totals.asOf ? formatMoney(totals.net) : '—'}</strong>
            </li>
            <li className="admin-stat">
              <span>Spendable today</span>
              <strong>{totals.spendableAsOf ? formatMoney(totals.spendable) : '—'}</strong>
            </li>
            <li className="admin-stat">
              <span>Owed</span>
              <strong className={totals.owed > 0 ? 'owed' : undefined}>{formatMoney(totals.owed)}</strong>
            </li>
          </ul>
          {archived.length > 0 && (
            <section className="fin-group archived" aria-labelledby="fin-group-archived">
              <div className="fin-group-head">
                <span className="fin-group-copy">
                  <h4 id="fin-group-archived" className="bills-head">
                    Archived
                  </h4>
                  <small>Kept, and left out of every total</small>
                </span>
              </div>
              <ul className="bill-list fin-list">
                {archived.map(a => (
                  <AccountItem key={a.id} account={a} today={today} whose={nameOf(a.memberId)} onOpen={() => onAccount(a.id)} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <button type="button" className="btn fin-checkin-all" onClick={onCheckIn}>
        Check in every account
      </button>
      <WeeklyCheckIn key={weekly?.dueAt ?? 'off'} task={weekly} onChange={onCheckInWeekly} />
    </section>
  )
}

/** An account as Manage lists it: its name, its kind ("Retirement"), whose, how old its balance is, and the balance. A tap opens its sheet. */
function AccountItem({ account: a, today, whose, onOpen }: { account: Account; today: string; whose: string | null; onOpen(): void }) {
  const latest = latestBalance(a)
  const owed = isLiability(a)
  return (
    <li className={a.archivedAt ? 'bill-row fin-item archived' : 'bill-row fin-item'}>
      <button type="button" className="bill-main" onClick={onOpen}>
        <span className="bill-glyph" aria-hidden="true">
          <AccountMark account={a} />
        </span>
        <span className="bill-copy">
          <strong>{a.name}</strong>
          <small>{[accountKindLabel(a), whose, latest ? ageOf(latest.on, today) : 'No balance yet'].filter(Boolean).join(' · ')}</small>
        </span>
        <span className={owed ? 'bill-amount owed' : 'bill-amount'}>{latest ? formatMoney(latest.amount) : '—'}</span>
      </button>
    </li>
  )
}

/** The goals in full, + Goal, and any whose set-asides were archived, to bring back. */
function GoalsPane({ tasks, at, onOpen, onOpenGoal, onAddGoal }: Props) {
  const goals = useMemo(() => savingGoals(tasks, at), [tasks, at])
  const archived = useMemo(() => moneySeries(tasks, isSaving).archived, [tasks])
  return (
    <section className="fin-pane" aria-label="Goals">
      <PaneBar label="Goals" add="+ Goal" onAdd={onAddGoal} />
      {goals.length === 0 ? (
        <p className="fin-empty">Saving for something? + Goal sets money aside on a schedule and keeps count of it.</p>
      ) : (
        <ul className="fin-goals">
          {goals.map(g => (
            <li key={g.task.id}>
              <GoalCard goal={g} onOpen={onOpenGoal} />
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <div className="fin-archived" role="group" aria-labelledby="fin-goals-archived">
          <h4 id="fin-goals-archived" className="bills-head">
            Archived
          </h4>
          <ul className="bill-list fin-list">
            {archived.map(t => (
              <SeriesRow key={t.id} task={t} whose={null} archived onOpen={onOpen} />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/**
 * Check in weekly: a repeating task (finance.ts), so it rings like any other.
 * The day and time are the open check-in's own; changing either moves it.
 */
function WeeklyCheckIn({ task, onChange }: { task: Task | null; onChange(slot: { weekday: number; time: string } | null): void }) {
  const slot = task?.dueAt ? slotOf(task.dueAt) : CHECK_IN_DEFAULT
  // a time is written when it is left, not at every turn of the picker
  const [time, setTime] = useState<string>(slot.time)
  const commitTime = () => {
    if (task && /^\d{2}:\d{2}$/.test(time) && time !== slot.time) onChange({ weekday: slot.weekday, time })
  }
  return (
    <div className="fin-weekly">
      <label className="field-inline fin-weekly-on">
        <input type="checkbox" className="tcheck" checked={!!task} onChange={e => onChange(e.target.checked ? { weekday: slot.weekday, time: slot.time } : null)} />
        <span>Check in weekly</span>
      </label>
      {task ? (
        <span className="fin-weekly-when">
          <select aria-label="Check-in day" value={slot.weekday} onChange={e => onChange({ weekday: Number(e.target.value), time: slot.time })}>
            {WEEKDAYS.map((w, i) => (
              <option key={w} value={i}>
                {w}
              </option>
            ))}
          </select>
          <input type="time" aria-label="Check-in time" value={time} onChange={e => setTime(e.target.value)} onBlur={commitTime} onKeyDown={e => e.key === 'Enter' && commitTime()} />
        </span>
      ) : (
        <small className="muted">A reminder on Sundays at 6 PM — on Home, the calendar and your phone — to type in what the accounts hold.</small>
      )}
    </div>
  )
}
