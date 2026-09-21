import { useMemo, useState } from 'react'
import { Segmented } from './stats/Segmented'
import { formatMoney, isPayday, monthlyCost, monthlyIncome, monthlySpare } from '../bills'
import { balanceOn, cashRunway, countable, firstShortfall, isLiability, isLiquid, latestBalance, moneyTotals, withBalance } from '../finance'
import { newerStamp } from '../itemops'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_META, OPEN_STATUSES, RECURRENCE_META, type Account, type AccountType, type Task } from '../types'
import { dateKey, uid } from '../utils'
import { Bills } from './Bills'
import { StatTile } from './bits'
import { ConfirmButton } from './ConfirmButton'

// Finance (v3.27): what Bills was, plus the two things it could not answer.
//
// Bills said what was due this month. It could not say whether there would be
// enough in the account before the 3rd, because nothing here knew what came IN
// or what the accounts held. A payday is a bill with the sign the other way
// round (bills.ts), and an account is a name and the balances you have typed.
//
// Drafter does not connect to a bank and never will. Everything below is
// arithmetic over what you wrote down — which is also why the runway is a
// floor rather than a forecast: it counts the one open occurrence of each
// series, so it can only turn out better than it says.

type Segment = 'bills' | 'paydays' | 'accounts'
const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'bills', label: 'Bills' },
  { key: 'paydays', label: 'Paydays' },
  { key: 'accounts', label: 'Accounts' },
]

const fmtDay = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
const dayLabel = (key: string) => new Date(`${key}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

interface Props {
  tasks: Task[]
  accounts: Account[]
  members: { id: string; displayName: string }[]
  onOpen(t: Task): void
  /** Open the task editor on a new bill, or on a new payday. */
  onNew(bill: { kind: 'bill' | 'income' }): void
  onMarkPaid(t: Task): void
  onSaveAccount(a: Account): void
  onRemoveAccount(id: string): void
  now?: Date
}

/** The strip every segment sits under: in, out, what is left, and what is actually there. */
function MoneyStrip({ tasks, accounts }: { tasks: Task[]; accounts: Account[] }) {
  const inPerMonth = useMemo(() => monthlyIncome(tasks), [tasks])
  const outPerMonth = useMemo(() => monthlyCost(tasks), [tasks])
  const spare = useMemo(() => monthlySpare(tasks), [tasks])
  const totals = useMemo(() => moneyTotals(accounts), [accounts])
  return (
    <div className="kpi-row bills-kpis">
      <StatTile label="In, a month" value={inPerMonth > 0 ? formatMoney(inPerMonth) : '—'} sub={inPerMonth > 0 ? 'every payday, averaged' : 'add a payday'} />
      <StatTile label="Out, a month" value={outPerMonth > 0 ? formatMoney(outPerMonth) : '—'} sub="every repeating payment" />
      <StatTile
        label="Left over"
        value={inPerMonth > 0 ? formatMoney(spare) : '—'}
        sub={inPerMonth > 0 ? (spare < 0 ? 'more goes out than comes in' : 'in an average month') : undefined}
        warn={inPerMonth > 0 && spare < 0}
      />
      <StatTile
        label="Liquid now"
        value={totals.asOf ? formatMoney(totals.liquid) : '—'}
        sub={totals.asOf ? `as of ${dayLabel(totals.asOf)}${totals.unknown ? ` · ${totals.unknown} not checked in` : ''}` : 'type in a balance'}
      />
    </div>
  )
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
  const monthAgo = dateKey(new Date(Date.now() - 30 * 86_400_000))
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

export function Finance({ tasks, accounts, members, onOpen, onNew, onMarkPaid, onSaveAccount, onRemoveAccount, now }: Props) {
  const [segment, setSegment] = useState<Segment>('bills')
  const [adding, setAdding] = useState<AccountType | null>(null)
  const nameOf = (id: string | undefined) => (id ? (members.find(m => m.id === id)?.displayName ?? null) : null)
  // read once, so the runway is not rebuilt on every render by a fresh clock
  const at = useMemo(() => now ?? new Date(), [now])

  const paydays = useMemo(
    () => tasks.filter(t => isPayday(t) && OPEN_STATUSES.includes(t.status)).sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999')),
    [tasks],
  )
  const runway = useMemo(() => cashRunway(accounts, tasks, 60, at), [accounts, tasks, at])
  const short = useMemo(() => firstShortfall(runway), [runway])
  const live = useMemo(() => countable(accounts), [accounts])
  const totals = useMemo(() => moneyTotals(accounts), [accounts])

  const addAccount = (type: AccountType) => {
    const stamp = new Date().toISOString()
    onSaveAccount({ kind: 'account', id: uid(), name: ACCOUNT_TYPE_META[type].label, type, balances: [], createdAt: stamp, updatedAt: stamp })
    setAdding(null)
  }

  return (
    <div className="bills finance">
      <div className="people-toolbar">
        <h2>Finance</h2>
        <Segmented items={SEGMENTS} value={segment} onChange={k => setSegment(k)} label="Finance view" />
      </div>

      <MoneyStrip tasks={tasks} accounts={accounts} />

      {short && (
        <p className="warn finance-short">
          On {dayLabel(short.day)} the money you can actually spend goes to {formatMoney(short.balance)} — counting only what is written down.
        </p>
      )}

      {segment === 'bills' && <Bills tasks={tasks} onOpen={onOpen} onNew={() => onNew({ kind: 'bill' })} onMarkPaid={onMarkPaid} />}

      {segment === 'paydays' && (
        <section className="finance-section">
          <div className="people-toolbar">
            <h3 className="bills-head">Money in</h3>
            <span className="spacer" />
            <button className="btn primary" onClick={() => onNew({ kind: 'income' })}>
              + Payday
            </button>
          </div>
          {paydays.length === 0 ? (
            <p className="empty">
              Add each person’s pay — what it is, who pays it, how often and when the next one lands. A payday sits on the calendar like a bill, and the strip above
              starts saying what is left over rather than only what goes out.
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
              above is worked out from it and from the bills and paydays you have written down.
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
                  <strong>{totals.asOf ? formatMoney(totals.liquid) : '—'}</strong>
                </li>
                <li className="admin-stat">
                  <span>Owed on cards</span>
                  <strong className={totals.owed > 0 ? 'warn' : undefined}>{formatMoney(totals.owed)}</strong>
                </li>
              </ul>
              {live.some(a => isLiquid(a)) && runway.length > 0 && (
                <>
                  <h3 className="bills-head">Next 60 days</h3>
                  <p className="field-hint">
                    Spendable cash after each day’s bills and paydays. Only what is written down is counted, and a repeating payment shows its next occurrence alone —
                    so this is the floor, not the forecast.
                  </p>
                  <ul className="bill-list runway">
                    {runway.map(d => (
                      <li key={d.day} className={d.balance < 0 ? 'bill-row overdue' : 'bill-row'}>
                        <span className="bill-copy">
                          <strong>{dayLabel(d.day)}</strong>
                          <small>{d.rows.map(r => `${r.income ? '+' : '−'}${formatMoney(r.amount)} ${r.title}`).join(' · ')}</small>
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
    </div>
  )
}
