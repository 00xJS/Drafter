import { useMemo, useState } from 'react'
import { billEmoji, formatMoney, monthlyCost, monthlyIncome, monthlySetAside, monthlySpare } from '../../bills'
import {
  CHECK_IN_DEFAULT,
  STALE_DAYS,
  TIMELINE_DAYS,
  afterLine,
  cashLine,
  comingUp,
  countable,
  daysBetween,
  isLiability,
  latestBalance,
  openCheckIn,
  safeToSpend,
  savingGoals,
  shortfallLine,
  slotOf,
  type GoalView,
  type MoneyRow,
  type SafeToSpend,
} from '../../finance'
import { ACCOUNT_TYPE_META, type Account, type Task } from '../../types'
import { Segmented } from '../stats/Segmented'
import { CashLineChart } from './CashLineChart'
import { PER, WEEKDAYS, ageOf, chipOf, dayLabel, moneyName, shortDay } from './labels'

// Finance's first screen, top to bottom: what is safe to spend until payday,
// the next 30 days as a line, what falls due in them, the accounts, the goals,
// and an average month. It only draws: every figure is finance.ts's or
// bills.ts's, the same ones the rest of Finance and the Stats lens read.

type Member = { id: string; displayName: string }

/** Where a Check in opens: on every account, on one of them, or on a new one. */
export type CheckInFocus = string | 'add' | undefined

interface Props {
  tasks: Task[]
  accounts: Account[]
  members: Member[]
  myId?: string | null
  /** The day it is, and noon on it: what every figure counts from. */
  today: string
  at: Date
  onOpen(t: Task): void
  onMarkPaid(t: Task): void
  onAddBill(): void
  onAddPayday(): void
  onAddGoal(): void
  onCheckIn(focus?: CheckInFocus): void
  /** The weekly check-in: turned on at a slot, moved to another, or turned off. */
  onCheckInWeekly(slot: { weekday: number; time: string } | null): void
}

const SPANS = [
  { key: '30', label: '30 days' },
  { key: '60', label: '60 days' },
] as const

export function Timeline({ tasks, accounts, members, myId, today, at, onOpen, onMarkPaid, onAddBill, onAddPayday, onAddGoal, onCheckIn, onCheckInWeekly }: Props) {
  const [span, setSpan] = useState<'30' | '60'>('30')
  const days = span === '60' ? 60 : TIMELINE_DAYS
  const safe = useMemo(() => safeToSpend(accounts, tasks, at), [accounts, tasks, at])
  const line = useMemo(() => cashLine(accounts, tasks, days, at), [accounts, tasks, days, at])
  const rows = useMemo(() => comingUp(tasks, at), [tasks, at])
  const goals = useMemo(() => savingGoals(tasks, at), [tasks, at])
  const live = useMemo(() => countable(accounts), [accounts])
  const weekly = useMemo(() => openCheckIn(tasks, myId), [tasks, myId])
  const month = useMemo(() => ({ in: monthlyIncome(tasks), out: monthlyCost(tasks), spare: monthlySpare(tasks), kept: monthlySetAside(tasks) }), [tasks])
  const nameOf = (id: string | undefined) => (id ? (members.find(m => m.id === id)?.displayName ?? null) : null)

  return (
    <div className="fin-timeline">
      <Hero safe={safe} today={today} onCheckIn={onCheckIn} />

      <div className="fin-actions" role="group" aria-label="Add to Finance">
        <button type="button" className="btn" onClick={onAddBill}>
          + Bill
        </button>
        <button type="button" className="btn" onClick={onAddPayday}>
          + Payday
        </button>
        <button type="button" className="btn" onClick={() => onCheckIn()}>
          Check in
        </button>
        <button type="button" className="btn" onClick={onAddGoal}>
          + Goal
        </button>
      </div>

      {line && (
        <section className="fin-card fin-line" aria-labelledby="fin-line-head">
          <div className="fin-card-head">
            <h3 id="fin-line-head">Cash, next {days} days</h3>
            <Segmented items={SPANS} value={span} onChange={k => setSpan(k)} label="How far the line looks" role="group" className="fin-span" />
          </div>
          <CashLineChart line={line} days={days} onToggle={() => setSpan(s => (s === '30' ? '60' : '30'))} />
          {line.short && <p className="warn fin-short">{shortfallLine(line.short, dayLabel)}</p>}
        </section>
      )}

      <section className="fin-section fin-coming" aria-labelledby="fin-coming-head">
        <div className="fin-section-head">
          <h3 id="fin-coming-head" className="bills-head">
            Coming up
          </h3>
          <small className="muted">next {TIMELINE_DAYS} days</small>
        </div>
        {rows.length === 0 ? (
          <p className="fin-empty">Nothing due in the next {TIMELINE_DAYS} days. + Bill has rent, power, internet and the rest ready to fill in.</p>
        ) : (
          <ul className="bill-list fin-rows">
            {rows.map(r => (
              <ComingRow key={r.task.id} row={r} today={today} whose={nameOf(r.task.bill.forMemberId)} onOpen={onOpen} onMarkPaid={onMarkPaid} />
            ))}
          </ul>
        )}
      </section>

      <section className="fin-section fin-accounts" aria-labelledby="fin-accounts-head">
        <div className="fin-section-head">
          <h3 id="fin-accounts-head" className="bills-head">
            Accounts
          </h3>
        </div>
        {live.length === 0 ? (
          <p className="fin-empty">
            No accounts yet. <strong>Check in</strong> adds the ones you keep an eye on and what each holds — Drafter never connects to a bank.
          </p>
        ) : (
          <ul className="fin-tiles">
            {live.map(a => (
              <li key={a.id}>
                <AccountTile account={a} today={today} whose={nameOf(a.memberId)} onCheckIn={() => onCheckIn(a.id)} />
              </li>
            ))}
            <li>
              <button type="button" className="fin-tile add" onClick={() => onCheckIn('add')}>
                + Account
              </button>
            </li>
          </ul>
        )}
        <WeeklyCheckIn key={weekly?.dueAt ?? 'off'} task={weekly} onChange={onCheckInWeekly} />
      </section>

      <section className="fin-section fin-goals-section" aria-labelledby="fin-goals-head">
        <div className="fin-section-head">
          <h3 id="fin-goals-head" className="bills-head">
            Goals
          </h3>
        </div>
        {goals.length === 0 ? (
          <p className="fin-empty">Saving for something? + Goal sets money aside on a schedule and keeps count of it.</p>
        ) : (
          <ul className="fin-goals">
            {goals.map(g => (
              <li key={g.task.id}>
                <GoalCard goal={g} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        )}
      </section>

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
    </div>
  )
}

/** Safe to spend until payday, or a Check in prompt before there is anything to count from. */
function Hero({ safe, today, onCheckIn }: { safe: SafeToSpend; today: string; onCheckIn(focus?: CheckInFocus): void }) {
  if (safe.amount === null) {
    return (
      <section className="fin-hero first" aria-labelledby="fin-hero-head">
        <h3 id="fin-hero-head" className="fin-hero-label">
          Safe to spend
        </h3>
        <p className="fin-hero-prompt">Type in what your checking and cash hold, and this says what is safe to spend until payday — after the bills and set-asides due before it. Savings stays out of it.</p>
        <button type="button" className="btn primary" onClick={() => onCheckIn()}>
          Check in
        </button>
      </section>
    )
  }
  const age = safe.asOf ? daysBetween(safe.asOf, today) : 0
  const stale = age >= STALE_DAYS
  const notes = [safe.unchecked ? `${safe.unchecked} account${safe.unchecked === 1 ? '' : 's'} not checked in` : '', safe.unpriced ? `${safe.unpriced} with no amount` : ''].filter(Boolean)
  return (
    <section className={safe.amount < 0 ? 'fin-hero short' : 'fin-hero'} aria-labelledby="fin-hero-head">
      <h3 id="fin-hero-head" className="fin-hero-label">
        {safe.payday ? 'Safe to spend until payday' : `Safe to spend · next ${TIMELINE_DAYS} days`}
      </h3>
      <p className="fin-hero-amount">{formatMoney(safe.amount)}</p>
      <p className="fin-hero-line">
        {safe.payday ? `${dayLabel(safe.payday.day)} · ` : ''}
        {afterLine(safe)}
        {safe.owed > 0 ? ` (${formatMoney(safe.owed)})` : ''}
      </p>
      <p className={stale ? 'fin-hero-asof stale' : 'fin-hero-asof'}>
        <span>
          {safe.asOf === today || !safe.asOf ? 'Balances from today' : `Balances as of ${shortDay(safe.asOf)}`}
          {notes.length > 0 && ` · ${notes.join(' · ')}`}
        </span>
        <button type="button" className="btn subtle fin-hero-checkin" onClick={() => onCheckIn()}>
          Check in
        </button>
      </p>
    </section>
  )
}

/** One bill, payday or set-aside in Coming up: its day, what it is, how much, and the control that settles it. */
function ComingRow({ row, today, whose, onOpen, onMarkPaid }: { row: MoneyRow; today: string; whose: string | null; onOpen(t: Task): void; onMarkPaid(t: Task): void }) {
  const t = row.task
  const name = moneyName(t, whose)
  const chip = chipOf(row.due)
  const soon = row.overdue ? 'Overdue' : row.day === today ? 'Today' : daysBetween(today, row.day) === 1 ? 'Tomorrow' : ''
  const byName = row.income && whose && !name.startsWith(whose) ? whose : ''
  const meta = [soon, byName, t.bill.payee, row.saving ? 'Into savings' : ''].filter(Boolean).join(' · ')
  const amount = row.amount === undefined ? '—' : row.income ? `+${formatMoney(row.amount)}` : formatMoney(row.amount)
  const verb = row.income ? 'Got it' : row.saving ? 'Saved' : 'Paid'
  const what = row.income ? 'received' : row.saving ? 'set aside' : 'paid'
  return (
    <li className={['bill-row', 'fin-row', row.overdue ? 'overdue' : '', row.income ? 'income' : ''].filter(Boolean).join(' ')}>
      <button type="button" className="bill-main" onClick={() => onOpen(t)}>
        <span className="fin-date">
          <small>{chip.weekday}</small> <strong>{chip.day}</strong>
        </span>{' '}
        <span className="bill-copy">
          <strong>
            <span aria-hidden="true">{billEmoji(t.bill)}</span> {name}
          </strong>{' '}
          <small>
            {meta}
            {t.bill.autopay && <span className={meta ? 'fin-tag' : 'fin-tag alone'}>Autopay</span>}
          </small>
        </span>{' '}
        <span className={row.amount === undefined ? 'bill-amount none' : row.income ? 'bill-amount in' : row.saving ? 'bill-amount kept' : 'bill-amount'}>{amount}</span>
      </button>
      <button type="button" className="btn subtle bill-pay" onClick={() => onMarkPaid(t)} aria-label={`Mark ${name} ${what}`}>
        {verb}
      </button>
    </li>
  )
}

/** An account as a tile: what it holds (or, for a card, owes) and how old that is. A tap checks it in. */
function AccountTile({ account, today, whose, onCheckIn }: { account: Account; today: string; whose: string | null; onCheckIn(): void }) {
  const latest = latestBalance(account)
  const owed = isLiability(account)
  const meta = ACCOUNT_TYPE_META[account.type]
  const age = latest ? ageOf(latest.on, today) : 'no balance yet'
  const stale = !!latest && daysBetween(latest.on, today) >= STALE_DAYS
  return (
    <button type="button" className="fin-tile" onClick={onCheckIn} aria-label={`${account.name}: ${latest ? `${formatMoney(latest.amount)}${owed ? ' owed' : ''}, ${age}` : 'no balance yet'}. Check in`}>
      <span className="fin-tile-name">
        <span aria-hidden="true">{meta.emoji}</span> {account.name}
      </span>
      <strong className={owed ? 'owed' : undefined}>{latest ? formatMoney(latest.amount) : '—'}</strong>
      <small className={stale ? 'stale' : undefined}>{[owed && latest ? 'owed' : '', whose, age].filter(Boolean).join(' · ')}</small>
    </button>
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

const STATUS_WORDS: Record<GoalView['status'], string> = { reached: 'Reached', 'on-track': 'On track', behind: 'Behind', open: 'No date' }

/** A savings goal: how far it has got, by when, and what goes in each time. A tap opens its next set-aside. */
function GoalCard({ goal: g, onOpen }: { goal: GoalView; onOpen(t: Task): void }) {
  const name = g.task.title.trim() || 'Savings'
  const each = g.each !== undefined && g.freq ? `${formatMoney(g.each)} ${PER[g.freq]}` : 'No amount set'
  const next = g.next && g.status !== 'reached' ? ` · next ${shortDay(g.next)}` : ''
  const help = g.status === 'behind' && g.needed !== undefined ? ` · ${formatMoney(g.needed)} each would get there` : g.status === 'open' && g.toGo ? ` · ${g.toGo} more to go` : ''
  return (
    <button type="button" className={`fin-goal ${g.status}`} onClick={() => onOpen(g.task)}>
      <span className="fin-goal-head">
        <span className="fin-goal-emoji" aria-hidden="true">
          {billEmoji(g.task.bill)}
        </span>
        <strong>{name}</strong>
        <span className={`fin-status ${g.status}`}>{STATUS_WORDS[g.status]}</span>
      </span>
      <span className="fin-bar" aria-hidden="true">
        <span style={{ width: `${g.pct}%` }} />
      </span>
      <span className="fin-goal-line">
        <strong>{formatMoney(g.saved)}</strong> of {formatMoney(g.target)}
        {g.by ? ` · by ${shortDay(g.by)}` : ''}
      </span>
      <small>
        {each}
        {next}
        {help}
      </small>
    </button>
  )
}
