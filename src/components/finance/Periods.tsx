import { useMemo } from 'react'
import { formatMoney } from '../../bills'
import {
  STALE_DAYS,
  TIMELINE_DAYS,
  countable,
  daysBetween,
  isLiability,
  latestBalance,
  lowLine,
  moneyForecast,
  payPeriods,
  safeToSpend,
  savingGoals,
  shortfallLine,
  undatedLine,
  type MoneyRow,
  type PayPeriod,
  type SafeToSpend,
} from '../../finance'
import type { Account, Task } from '../../types'
import { Icon } from '../Icon'
import { GoalRow } from './Goals'
import { AccountMark } from './KindMark'
import { ageOf, dayLabel, moneyName, shortDay } from './labels'
import { ComingRow, UndatedRow, soonWord } from './Rows'

// Finance's first screen (the owner's pick, 2026-09-24): the money cut at each
// payday. Safe to spend on top, then what has no date, then one card for each
// paycheck — what it has to cover before the next one lands, how much of it
// that takes, and what is left when the next one does — then the accounts and
// the goals. Everything else is in Manage, a tap away.
//
// It only draws. Every figure is finance.ts's and read off one forecast: the
// periods are its rows cut at each payday (payPeriods), what is left is its
// line on the day, and safe to spend is the lowest that line goes.

/** Where a Check in opens: on every account, on one of them, or on a new one. */
export type CheckInFocus = string | 'add' | undefined

type Member = { id: string; displayName: string }

interface Props {
  tasks: Task[]
  accounts: Account[]
  members: Member[]
  /** The day it is, and noon on it: what every figure counts from. */
  today: string
  at: Date
  /** How far the periods look: 30 days, or 60 once more were asked for. */
  days: number
  onDays(days: number): void
  onManage(): void
  /** The + : what can be added, as a sheet of its own. */
  onAdd(): void
  /** A row's short sheet (Finance decides which). */
  onOpen(t: Task): void
  /** A goal's next set-aside, in the editor. */
  onOpenGoal(t: Task): void
  onMarkPaid(t: Task): void
  /** A bill, payday or set-aside under Needs a date given one: YYYY-MM-DD. */
  onDate(t: Task, day: string): void
  onCheckIn(focus?: CheckInFocus): void
  onAccount(id: string): void
  /** The cash line, in a sheet. */
  onLine(): void
}

export function Periods({ tasks, accounts, members, today, at, days, onDays, onManage, onAdd, onOpen, onOpenGoal, onMarkPaid, onDate, onCheckIn, onAccount, onLine }: Props) {
  const safe = useMemo(() => safeToSpend(accounts, tasks, at), [accounts, tasks, at])
  const forecast = useMemo(() => moneyForecast(accounts, tasks, days, at), [accounts, tasks, days, at])
  const periods = useMemo(() => payPeriods(forecast), [forecast])
  const goals = useMemo(() => savingGoals(tasks, at), [tasks, at])
  const live = useMemo(() => countable(accounts), [accounts])
  const nameOf = (id: string | undefined) => (id ? (members.find(m => m.id === id)?.displayName ?? null) : null)
  const whose = (t: Task) => nameOf(t.bill?.forMemberId)
  const say = (rows: MoneyRow[]) => rows.map(r => moneyName(r.task, whose(r.task))).join(' and ')

  return (
    <div className="fin-periods">
      <div className="fin-top">
        <button type="button" className="btn subtle fin-manage-open" onClick={onManage}>
          Manage
          <span className="fin-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <span className="spacer" />
        <button type="button" className="btn fin-plus" aria-label="Add to Finance" title="Add to Finance" onClick={onAdd}>
          <Icon name="plus" size={20} strokeWidth={2.2} />
        </button>
      </div>

      <Summary safe={safe} today={today} whose={whose} onCheckIn={onCheckIn} onLine={onLine} />

      <section className="fin-plan" aria-labelledby="fin-plan-head">
        {forecast.undated.length > 0 && (
          <section className="fin-needs" aria-labelledby="fin-undated-head">
            <h3 id="fin-undated-head" className="fin-undated-head">
              Needs a date
            </h3>
            <ul className="bill-list fin-rows">
              {forecast.undated.map(t => (
                <UndatedRow key={t.id} task={t} today={today} whose={whose(t)} onOpen={onOpen} onDate={onDate} />
              ))}
            </ul>
          </section>
        )}
        <div className="fin-section-head">
          <h3 id="fin-plan-head" className="bills-head">
            Pay periods
          </h3>
          <small className="muted">next {days} days</small>
        </div>
        {periods.length > 0 ? (
          <ol className="fin-period-list">
            {periods.map(p => (
              <li key={p.key}>
                <PeriodCard period={p} today={today} whose={whose} say={say} onOpen={onOpen} onMarkPaid={onMarkPaid} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="fin-empty">Nothing due in the next {days} days. The + adds a bill — rent, power, internet and the rest are ready to fill in — or a payday.</p>
        )}
        <button type="button" className="btn subtle fin-more-days" onClick={() => onDays(days === TIMELINE_DAYS ? TIMELINE_DAYS * 2 : TIMELINE_DAYS)}>
          {days === TIMELINE_DAYS ? `Show ${TIMELINE_DAYS} more days` : `Back to ${TIMELINE_DAYS} days`}
        </button>
      </section>

      <section className="fin-strip" aria-labelledby="fin-strip-head">
        <h3 id="fin-strip-head" className="bills-head">
          Accounts
        </h3>
        <ul className="fin-chips">
          {live.map(a => (
            <li key={a.id}>
              <AccountChip account={a} today={today} behind={safe.stale.some(s => s.account.id === a.id)} whose={nameOf(a.memberId)} onOpen={() => onAccount(a.id)} />
            </li>
          ))}
          <li>
            <button type="button" className="fin-chip fin-chip-checkin" onClick={() => onCheckIn()}>
              <span className="fin-chip-name">{live.length ? 'Check in' : 'Add an account'}</span>
              <small>{live.length ? 'Type in today’s balances' : 'and what it holds'}</small>
            </button>
          </li>
        </ul>
      </section>

      {goals.length > 0 && (
        <section className="fin-goals-mini" aria-labelledby="fin-goals-head">
          <h3 id="fin-goals-head" className="bills-head">
            Goals
          </h3>
          <ul className="fin-goal-rows">
            {goals.map(g => (
              <li key={g.task.id}>
                <GoalRow goal={g} onOpen={onOpenGoal} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * Safe to spend: the lowest the line goes in the next 30 days, and the day it
 * gets there. Or a Check in prompt, before there is anything to count from.
 */
function Summary({ safe, today, whose, onCheckIn, onLine }: { safe: SafeToSpend; today: string; whose(t: Task): string | null; onCheckIn(focus?: CheckInFocus): void; onLine(): void }) {
  if (safe.amount === null) {
    return (
      <section className="fin-hero first" aria-labelledby="fin-hero-head">
        <h3 id="fin-hero-head" className="fin-hero-label">
          Safe to spend
        </h3>
        <p className="fin-hero-prompt">
          Type in what your checking and cash hold, and this says what is safe to spend today — with every payday, bill and set-aside in the next {TIMELINE_DAYS} days counted on its
          day. Savings stays out of it.
        </p>
        <button type="button" className="btn primary" onClick={() => onCheckIn()}>
          Check in
        </button>
      </section>
    )
  }
  const age = safe.asOf ? daysBetween(safe.asOf, today) : 0
  const stale = age >= STALE_DAYS
  const notes = [safe.unchecked ? `${safe.unchecked} account${safe.unchecked === 1 ? '' : 's'} not checked in` : '', safe.unpriced ? `${safe.unpriced} with no amount` : ''].filter(Boolean)
  const undated = undatedLine(safe.undated)
  const name = (r: MoneyRow) => moneyName(r.task, whose(r.task))
  return (
    <section className={safe.amount < 0 ? 'fin-hero short' : 'fin-hero'} aria-labelledby="fin-hero-head">
      <div className="fin-hero-top">
        <h3 id="fin-hero-head" className="fin-hero-label">
          Safe to spend
        </h3>
        <button type="button" className="btn subtle fin-see-line" onClick={onLine}>
          See the line
        </button>
      </div>
      <p className="fin-hero-amount">{formatMoney(safe.amount)}</p>
      <p className="fin-hero-line">{lowLine(safe, today, { day: dayLabel, short: shortDay, payday: name, bill: name })}</p>
      {safe.short && <p className="warn fin-short">{shortfallLine(safe.short, dayLabel)}</p>}
      {undated && <p className="fin-hero-undated">{undated}</p>}
      <p className={stale ? 'fin-hero-asof stale' : 'fin-hero-asof'}>
        <span>
          {safe.asOf === today || !safe.asOf ? 'Balances from today' : `Balances as of ${shortDay(safe.asOf)}`}
          {notes.length > 0 && ` · ${notes.join(' · ')}`}
          {/* checking or cash left out of the check-ins since: in the figure as it stands, and said, quietly */}
          {safe.stale.map(s => (
            <span key={s.account.id} className="fin-hero-behind">
              {s.account.name} · last checked in {shortDay(s.on)}
            </span>
          ))}
        </span>
        <button type="button" className="btn subtle fin-hero-checkin" onClick={() => onCheckIn(safe.stale[0]?.account.id)}>
          Check in
        </button>
      </p>
    </section>
  )
}

/**
 * One paycheck's card: the payday (or Now, before the first), how much of it
 * the bills in its stretch take, the bills and set-asides themselves, and
 * what is left on the line the day before the next one lands.
 */
function PeriodCard({
  period: p,
  today,
  whose,
  say,
  onOpen,
  onMarkPaid,
}: {
  period: PayPeriod
  today: string
  whose(t: Task): string | null
  say(rows: MoneyRow[]): string
  onOpen(t: Task): void
  onMarkPaid(t: Task): void
}) {
  const now = p.paydays.length === 0
  const label = now ? 'Now' : `${say(p.paydays)} · ${dayLabel(p.from)}`
  const over = p.share !== null && p.share > 100
  return (
    <section className={['fin-period', now ? 'now' : '', p.paydays.every(r => r.projected) ? 'projected' : ''].filter(Boolean).join(' ')} aria-label={label}>
      <header className="fin-period-head">
        {now ? (
          <div className="fin-now">
            <strong>Now</strong>
            <small>{p.next.length ? `Before ${say(p.next)}` : `Through ${shortDay(p.to)}`}</small>
          </div>
        ) : (
          p.paydays.map(r => <PaydayLine key={`${r.task.id}@${r.due}`} row={r} today={today} whose={whose(r.task)} onOpen={onOpen} onMarkPaid={onMarkPaid} />)
        )}
      </header>
      {p.share !== null && p.out > 0 && (
        <div className={over ? 'fin-take over' : 'fin-take'}>
          <span className="fin-take-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, p.share)}%` }} />
          </span>
          <small>
            {formatMoney(p.out)} due · {p.share}% of this pay
          </small>
        </div>
      )}
      {p.rows.length > 0 ? (
        <ul className="bill-list fin-rows fin-period-rows">
          {p.rows.map(r => (
            <ComingRow key={`${r.task.id}@${r.due}`} row={r} today={today} whose={whose(r.task)} onOpen={onOpen} onMarkPaid={onMarkPaid} />
          ))}
        </ul>
      ) : (
        <p className="fin-period-none">Nothing falls due{p.next.length ? ` before ${say(p.next)}` : ''}.</p>
      )}
      {p.left !== null && (
        <footer className="fin-period-left">
          <span>{p.next.length ? `Left before ${say(p.next)}` : `Left on ${shortDay(p.to)}`}</span>
          <strong className={p.left < 0 ? 'owed' : undefined}>{formatMoney(p.left)}</strong>
        </footer>
      )}
    </section>
  )
}

/**
 * A payday at the head of its card: whose it is and how much on one line, when
 * under it the whole width, so the day keeps the room it needs on a phone, and
 * Got it beside them on the real open one.
 */
function PaydayLine({ row, today, whose, onOpen, onMarkPaid }: { row: MoneyRow; today: string; whose: string | null; onOpen(t: Task): void; onMarkPaid(t: Task): void }) {
  const name = moneyName(row.task, whose)
  // pay is expected, never overdue: one whose day has gone is still to be marked received
  const state = row.done ? 'Received' : row.projected || row.overdue ? (row.due < today ? 'Expected by now' : 'Expected') : soonWord(row.due, today, false)
  const open = !row.projected && !row.done
  return (
    <div className={['fin-payday', row.projected ? 'projected' : '', row.done ? 'done' : ''].filter(Boolean).join(' ')}>
      <button type="button" className="fin-payday-main" onClick={() => onOpen(row.task)}>
        <strong>
          <span aria-hidden="true">💵</span> {name}
        </strong>{' '}
        <small>{[dayLabel(row.due), state].filter(Boolean).join(' · ')}</small>{' '}
        <span className={row.amount === undefined ? 'bill-amount none' : 'bill-amount in'}>{row.amount === undefined ? '—' : `+${formatMoney(row.amount)}`}</span>
      </button>
      {open && (
        <button type="button" className="btn subtle bill-pay" onClick={() => onMarkPaid(row.task)} aria-label={`Mark ${name} received`}>
          Got it
        </button>
      )}
    </div>
  )
}

/**
 * An account in the strip: its name, what it holds (for a card, what is owed)
 * and how old that is. One `behind` the newest check-in on checking and cash
 * (staleSpendable) says when it was last checked in. A tap opens its sheet.
 */
function AccountChip({ account, today, behind, whose, onOpen }: { account: Account; today: string; behind: boolean; whose: string | null; onOpen(): void }) {
  const latest = latestBalance(account)
  const owed = isLiability(account)
  const age = !latest ? 'no balance yet' : behind ? `last checked in ${shortDay(latest.on)}` : ageOf(latest.on, today)
  const stale = !latest || behind || daysBetween(latest.on, today) >= STALE_DAYS
  return (
    <button
      type="button"
      className="fin-chip"
      onClick={onOpen}
      aria-label={`${account.name}: ${latest ? `${formatMoney(latest.amount)}${owed ? ' owed' : ''}, ${age}` : 'no balance yet'}${whose ? `, ${whose}’s` : ''}`}
    >
      <span className="fin-chip-name">
        <span aria-hidden="true">
          <AccountMark account={account} />
        </span> {account.name}
      </span>
      <span className="fin-chip-line">
        <strong className={owed ? 'owed' : undefined}>{latest ? formatMoney(latest.amount) : '—'}</strong>
        <small className={stale ? 'stale' : undefined}>{[owed && latest ? 'owed' : '', age].filter(Boolean).join(' · ')}</small>
      </span>
    </button>
  )
}
