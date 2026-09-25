import { useEffect, useMemo, useState } from 'react'
import { Segmented } from './stats/Segmented'
import { formatMoney, isPayday } from '../bills'
import { balanceOn, checkInDone, checkInTask, countable, isLiability, isSpendable, latestBalance, moneyForecast, moneyTotals, nextSlot, openCheckIn, shortfallLine, withBalance } from '../finance'
import { localMidnightIso, newerStamp } from '../itemops'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_META, OPEN_STATUSES, RECURRENCE_META, type Account, type AccountType, type Task } from '../types'
import { dateKey, uid } from '../utils'
import { shiftDayKey } from '../journal'
import { noonOf, useDayKey } from '../useDayKey'
import { Bills } from './Bills'
import { ConfirmButton } from './ConfirmButton'
import { BillSheet } from './finance/BillSheet'
import { CheckInSheet, type CheckInChange } from './finance/CheckInSheet'
import { GoalSheet } from './finance/GoalSheet'
import { WEEKDAYS, dayLabel, moneyName } from './finance/labels'
import { Timeline, type CheckInFocus } from './finance/Timeline'

// Finance (v3.27): what Bills was, plus the two things it could not answer.
//
// Bills said what was due this month. It could not say whether there would be
// enough in the account before the 3rd, because nothing here knew what came IN
// or what the accounts held. A payday is a bill with the sign the other way
// round (bills.ts), and an account is a name and the balances you have typed.
//
// Drafter does not connect to a bank and never will. Everything below is
// arithmetic over what you wrote down, by one rule (finance.ts): the balance
// checked in is the truth on its day, and every bill, payday and set-aside
// dated after it counts, money in and out alike, each repeat every time it
// lands.
//
// It opens on the timeline (finance/Timeline.tsx): one screen that answers
// "how much can we spend and still cover what is coming?" with what is safe to
// spend, the next 30 days as a line, what falls due, the accounts and the
// savings goals. The month of bills, the paydays and the accounts as they
// always were are the segments beside it.

type Segment = 'timeline' | 'bills' | 'paydays' | 'accounts'
const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'bills', label: 'Bills' },
  { key: 'paydays', label: 'Paydays' },
  { key: 'accounts', label: 'Accounts' },
]

/** The sheet over Finance, if any: Check in (on one account, or adding one), + Bill's templates, or + Goal. */
type Sheet = { kind: 'checkin'; focus?: CheckInFocus } | { kind: 'bill' } | { kind: 'goal' }

const fmtDay = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(2026, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

interface Props {
  tasks: Task[]
  accounts: Account[]
  members: { id: string; displayName: string }[]
  /** The reader: the weekly check-in is each member's own. */
  myId?: string | null
  /** More than one member: a bill or a goal added here says who can see it. */
  inHousehold?: boolean
  onOpen(t: Task): void
  /** The task editor on a new payday, or on a bill with more to it than + Bill's short form. */
  onNew(preset: Partial<Task>): void
  onMarkPaid(t: Task): void
  /** A bill or a goal from Finance's own forms, or the weekly check-in turned on: written, with a toast and its Undo. */
  onAdd(t: Task, message: string): void
  /** The weekly check-in moved to another day or time, or money with no date given one. */
  onSaveTask(t: Task): void
  /** The weekly check-in turned off: to the Trash, with an Undo. */
  onRemoveTask(t: Task): void
  onSaveAccount(a: Account): void
  onRemoveAccount(id: string): void
  /** A Check in: every account written at once, and this week's check-in ticked off when it was due. */
  onCheckIn(changes: CheckInChange[], done: Task | null): void
  /** Open on Check in: handed over by the weekly check-in's task or its reminder. */
  checkIn?: boolean
  onCheckInOpened?(): void
  now?: Date
}

/** One payday row: whose it is, who pays it, how often, how much. */
function PaydayRow({ t, whose, onOpen, onMarkPaid }: { t: Task; whose: string | null; onOpen(t: Task): void; onMarkPaid(t: Task): void }) {
  const meta = [whose, t.bill?.payee, t.dueAt ? `Next ${fmtDay(t.dueAt)}` : '', t.recurrence ? RECURRENCE_META[t.recurrence.freq] : 'One-off'].filter(Boolean).join(' · ')
  return (
    <li className="bill-row upcoming">
      <button type="button" className="bill-main" onClick={() => onOpen(t)}>
        <span className="bill-glyph" aria-hidden>
          💵
        </span>
        <span className="bill-copy">
          <strong>{t.title || 'Payday'}</strong>
          <small>{meta}</small>
        </span>
        <span className="bill-amount in">{formatMoney(t.estimateCost)}</span>
      </button>
      <button type="button" className="btn subtle bill-pay" onClick={() => onMarkPaid(t)} aria-label={`Mark ${t.title || 'payday'} received`}>
        Got it
      </button>
    </li>
  )
}

/** One account: what it holds, when that was true, and a box to type in a new figure. */
function AccountRow({ account, whose, onSave, onRemove }: { account: Account; whose: string | null; onSave(a: Account): void; onRemove(id: string): void }) {
  const [typing, setTyping] = useState('')
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(account.name)
  const latest = latestBalance(account)
  const meta = ACCOUNT_TYPE_META[account.type]
  // a month back, so a row can say which way it is going without a chart
  const monthAgo = shiftDayKey(useDayKey(), -30)
  const then = balanceOn(account, monthAgo)
  const move = latest && then && then.on !== latest.on ? Math.round((latest.amount - then.amount) * 100) / 100 : null

  const save = () => {
    const amount = Number(typing.replace(/[^0-9.-]/g, ''))
    if (!Number.isFinite(amount)) return
    setTyping('')
    onSave({ ...withBalance(account, amount), updatedAt: newerStamp(account.updatedAt) })
  }

  return (
    <li className={account.archivedAt ? 'bill-row account-row archived' : 'bill-row account-row'}>
      <span className="bill-glyph" aria-hidden>
        {meta.emoji}
      </span>
      <span className="bill-copy">
        {editing ? (
          <input
            value={name}
            aria-label="Account name"
            onChange={e => setName(e.target.value)}
            onBlur={() => {
              setEditing(false)
              if (name.trim() && name !== account.name) onSave({ ...account, name: name.trim(), updatedAt: newerStamp(account.updatedAt) })
            }}
          />
        ) : (
          <strong>
            {/* not .row-open: that class means "the row decides what a click
                does" and carries no handler of its own (a11y.test.ts). This
                one really is its own control — it renames the account. */}
            <button type="button" className="account-name" onClick={() => setEditing(true)} title="Rename">
              {account.name}
            </button>
          </strong>
        )}
        <small>
          {[meta.label, whose, latest ? `as of ${dayLabel(latest.on)}` : 'nothing typed in yet', account.archivedAt ? 'closed' : ''].filter(Boolean).join(' · ')}
          {move !== null && (
            <span className={move < 0 ? 'warn' : 'sync-ok'}>
              {' · '}
              {move < 0 ? '↓' : '↑'} {formatMoney(Math.abs(move))} in 30 days
            </span>
          )}
        </small>
      </span>
      <span className={isLiability(account) ? 'bill-amount owed' : 'bill-amount'}>{latest ? formatMoney(latest.amount) : '—'}</span>
      <span className="account-actions">
        <input
          className="account-entry"
          inputMode="decimal"
          placeholder="Balance today"
          aria-label={`Balance for ${account.name} today`}
          value={typing}
          onChange={e => setTyping(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
        />
        <button type="button" className="btn" disabled={!typing.trim()} onClick={save}>
          Save
        </button>
        <button
          type="button"
          className="btn subtle"
          onClick={() => onSave({ ...account, archivedAt: account.archivedAt ? undefined : new Date().toISOString(), updatedAt: newerStamp(account.updatedAt) })}
        >
          {account.archivedAt ? 'Reopen' : 'Close'}
        </button>
        <ConfirmButton className="btn subtle danger" confirmLabel="Delete it?" onConfirm={() => onRemove(account.id)}>
          Delete
        </ConfirmButton>
      </span>
    </li>
  )
}

export function Finance(props: Props) {
  const { tasks, accounts, members, myId, inHousehold = false, onOpen, onNew, onMarkPaid, onAdd, onSaveTask, onRemoveTask, onSaveAccount, onRemoveAccount, onCheckIn, checkIn = false, onCheckInOpened, now } = props
  const [segment, setSegment] = useState<Segment>('timeline')
  const [adding, setAdding] = useState<AccountType | null>(null)
  // Check in, asked for from elsewhere — the weekly check-in's task, its
  // reminder — lands here with Finance not yet drawn, so it opens the sheet
  // from the first render, and again when it is asked while Finance is up
  const [sheet, setSheet] = useState<Sheet | null>(() => (checkIn ? { kind: 'checkin' } : null))
  const [asked, setAsked] = useState(checkIn)
  if (checkIn !== asked) {
    setAsked(checkIn)
    if (checkIn) setSheet({ kind: 'checkin' })
  }
  useEffect(() => {
    if (checkIn) onCheckInOpened?.()
  }, [checkIn, onCheckInOpened])

  const nameOf = (id: string | undefined) => (id ? (members.find(m => m.id === id)?.displayName ?? null) : null)
  // read by the day, so the runway is not rebuilt on every render by a fresh
  // clock, and still starts from today once midnight has passed on a phone
  // left open here, as the bills beside it do (useDayKey)
  const dayKey = useDayKey()
  const at = useMemo(() => now ?? noonOf(dayKey), [now, dayKey])
  const today = now ? dateKey(now) : dayKey

  const paydays = useMemo(
    () => tasks.filter(t => isPayday(t) && OPEN_STATUSES.includes(t.status)).sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999')),
    [tasks],
  )
  // the 60 days under Accounts: the same forecast the timeline reads, looking further
  const plan = useMemo(() => moneyForecast(accounts, tasks, 60, at), [accounts, tasks, at])
  const runway = plan.days
  const short = plan.short
  const live = useMemo(() => countable(accounts), [accounts])
  const totals = useMemo(() => moneyTotals(accounts), [accounts])

  const addAccount = (type: AccountType) => {
    const stamp = new Date().toISOString()
    onSaveAccount({ kind: 'account', id: uid(), name: ACCOUNT_TYPE_META[type].label, type, balances: [], createdAt: stamp, updatedAt: stamp })
    setAdding(null)
  }
  // a payday is the household's picture as much as a bill is: shared unless kept back
  const newPayday = () => onNew({ bill: { kind: 'income' }, recurrence: { freq: 'biweekly' }, title: 'Payday', ...(inHousehold ? { shared: true } : {}) })
  /** Needs a date: the day typed in, as + Bill writes one (local midnight, a day with no time). */
  const dateMoney = (t: Task, day: string) => {
    const dueAt = localMidnightIso(day)
    if (dueAt) onSaveTask({ ...t, dueAt, updatedAt: newerStamp(t.updatedAt) })
  }

  /** Check in weekly: on at a slot, moved to another, or off. The slot is the open check-in's own due time. */
  const setWeekly = (slot: { weekday: number; time: string } | null) => {
    const current = openCheckIn(tasks, myId)
    if (!slot) {
      if (current) onRemoveTask(current)
      return
    }
    const next = nextSlot(new Date(), slot.weekday, slot.time)
    if (current) onSaveTask({ ...current, dueAt: next.toISOString(), updatedAt: newerStamp(current.updatedAt) })
    else onAdd(checkInTask(next, { id: uid(), now: new Date().toISOString() }), `Check in weekly: ${WEEKDAYS[slot.weekday]}s at ${timeLabel(slot.time)}`)
  }

  return (
    <div className="bills finance">
      <Segmented items={SEGMENTS} value={segment} onChange={k => setSegment(k)} label="Finance view" className="finance-seg" />

      {segment === 'timeline' && (
        <Timeline
          tasks={tasks}
          accounts={accounts}
          members={members}
          myId={myId}
          today={today}
          at={at}
          onOpen={onOpen}
          onMarkPaid={onMarkPaid}
          onAddBill={() => setSheet({ kind: 'bill' })}
          onAddPayday={newPayday}
          onAddGoal={() => setSheet({ kind: 'goal' })}
          onDate={dateMoney}
          onCheckIn={focus => setSheet({ kind: 'checkin', focus })}
          onCheckInWeekly={setWeekly}
        />
      )}

      {segment === 'bills' && <Bills tasks={tasks} onOpen={onOpen} onNew={() => setSheet({ kind: 'bill' })} onMarkPaid={onMarkPaid} />}

      {segment === 'paydays' && (
        <section className="finance-section">
          <div className="people-toolbar">
            <h3 className="bills-head">Money in</h3>
            <span className="spacer" />
            <button className="btn primary" onClick={newPayday}>
              + Payday
            </button>
          </div>
          {paydays.length === 0 ? (
            <p className="empty">
              Add each person’s pay — how much, how often and when the next one lands. A payday sits on the calendar like a bill, and the timeline counts every
              one of them on its day, the way it counts the bills.
            </p>
          ) : (
            <ul className="bill-list">
              {paydays.map(t => (
                <PaydayRow key={t.id} t={t} whose={nameOf(t.bill?.forMemberId)} onOpen={onOpen} onMarkPaid={onMarkPaid} />
              ))}
            </ul>
          )}
        </section>
      )}

      {segment === 'accounts' && (
        <section className="finance-section">
          <div className="people-toolbar">
            <h3 className="bills-head">Accounts</h3>
            <span className="spacer" />
            {adding ? (
              <span className="segmented" role="group" aria-label="What kind of account">
                {ACCOUNT_TYPES.map(t => (
                  <button key={t} type="button" className="seg" onClick={() => addAccount(t)}>
                    {ACCOUNT_TYPE_META[t].label}
                  </button>
                ))}
              </span>
            ) : (
              <button className="btn primary" onClick={() => setAdding('checking')}>
                + Account
              </button>
            )}
          </div>
          {live.length === 0 ? (
            <p className="empty">
              Add an account and type in what it holds. Drafter never connects to a bank — this is your own note of the balance, on the day it was true, and everything
              Finance works out comes from it and from the bills and paydays you have written down.
            </p>
          ) : (
            <>
              <ul className="bill-list">
                {accounts
                  .filter(a => !a.deletedAt)
                  .map(a => (
                    <AccountRow key={a.id} account={a} whose={nameOf(a.memberId)} onSave={onSaveAccount} onRemove={onRemoveAccount} />
                  ))}
              </ul>
              <ul className="admin-stats finance-totals">
                <li className="admin-stat">
                  <span>Net worth</span>
                  <strong>{totals.asOf ? formatMoney(totals.net) : '—'}</strong>
                </li>
                <li className="admin-stat">
                  <span>Spendable today</span>
                  <strong>{totals.spendableAsOf ? formatMoney(totals.spendable) : '—'}</strong>
                </li>
                <li className="admin-stat">
                  <span>Owed on cards</span>
                  <strong className={totals.owed > 0 ? 'warn' : undefined}>{formatMoney(totals.owed)}</strong>
                </li>
              </ul>
              {live.some(a => isSpendable(a)) && runway.length > 0 && (
                <>
                  <h3 className="bills-head">Next 60 days</h3>
                  <p className="field-hint">
                    Checking and cash after each day’s bills, paydays and set-asides, from the balance you checked in. Only what is written down is counted, and a
                    repeating one every time it comes round, money in and out alike.
                  </p>
                  {short && <p className="warn finance-short">{shortfallLine(short, dayLabel)}</p>}
                  <ul className="bill-list runway">
                    {runway.map(d => (
                      <li key={d.day} className={d.balance < 0 ? 'bill-row overdue' : 'bill-row'}>
                        <span className="bill-copy">
                          <strong>{dayLabel(d.day)}</strong>
                          <small>
                            {d.rows.map(r => `${r.income ? '+' : '−'}${formatMoney(r.amount)} ${moneyName(r.task, nameOf(r.task.bill.forMemberId))}${r.saving ? ' (to savings)' : ''}`).join(' · ')}
                          </small>
                        </span>
                        <span className={d.balance < 0 ? 'bill-amount owed' : 'bill-amount'}>{formatMoney(d.balance)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      )}

      {sheet?.kind === 'checkin' && (
        <CheckInSheet
          accounts={live}
          focus={sheet.focus}
          today={today}
          onClose={() => setSheet(null)}
          onSave={changes => {
            onCheckIn(changes, checkInDone(tasks, myId, new Date()))
            setSheet(null)
          }}
        />
      )}
      {sheet?.kind === 'bill' && (
        <BillSheet
          inHousehold={inHousehold}
          onClose={() => setSheet(null)}
          onMore={preset => {
            setSheet(null)
            onNew(preset)
          }}
          onAdd={t => {
            onAdd(t, `Added “${t.title}”`)
            setSheet(null)
          }}
        />
      )}
      {sheet?.kind === 'goal' && (
        <GoalSheet
          today={today}
          at={at}
          inHousehold={inHousehold}
          onClose={() => setSheet(null)}
          onAdd={t => {
            onAdd(t, `Saving for “${t.title}”`)
            setSheet(null)
          }}
        />
      )}
    </div>
  )
}
