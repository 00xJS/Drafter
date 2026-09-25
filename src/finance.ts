import { formatMoney, isMoney, isPayday, isSaving, savedSoFar } from './bills'
import { ACCOUNT_TYPE_META, HOLDING_META, OPEN_STATUSES, type Account, type AccountHolding, type AccountType, type BalanceCheck, type Bill, type RecurrenceFreq, type Task } from './types'
import { dateKey } from './utils'
import { CHECK_IN_PREFIX, isCheckIn, seriesRoot, stepDue } from '../shared/domain.mts'
import { isOverdue } from '../shared/due.mts'
import { shiftDayKey } from '../shared/journal.mts'

// Money, beyond the month of bills (v3.27).
//
// Bills answered "what is due this month". It could not answer the question
// underneath it — is there enough in there before the 3rd — because nothing
// here knew what came IN or what the accounts held. Paydays are bills with the
// sign the other way round (bills.ts), and an account is a name and the
// balances you have typed in.
//
// Drafter never connects to a bank and never will. Every figure below is
// arithmetic over what you told it: a balance you typed, plus the paydays and
// bills you wrote down, forward from the day that balance was true. That is
// the same contract Cashflow Compass keeps, and the reason its numbers can be
// trusted — nothing here is guessing at your money.

/** An account's newest check-in, or null when none has been typed in. */
export function latestBalance(account: Account): BalanceCheck | null {
  return account.balances.length ? account.balances[account.balances.length - 1] : null
}

/** What it held on `day`, or the newest check-in before it. Null when nothing was typed in by then. */
export function balanceOn(account: Account, day: string): BalanceCheck | null {
  let found: BalanceCheck | null = null
  for (const b of account.balances) {
    if (b.on > day) break
    found = b
  }
  return found
}

/**
 * A balance written in, keeping one per day. `on` is a day key, so typing
 * today's figure again replaces today's rather than adding a second — which is
 * what you want, because the second one is a correction of the first.
 */
export function withBalance(account: Account, amount: number, on = dateKey(new Date())): Account {
  const rest = account.balances.filter(b => b.on !== on)
  return { ...account, balances: [...rest, { on, amount: Math.round(amount * 100) / 100 }].sort((a, b) => a.on.localeCompare(b.on)) }
}

/** A credit card's balance is money OWED, so it counts against you. */
export const isLiability = (a: Account): boolean => !!ACCOUNT_TYPE_META[a.type].liability
/** Money you could actually spend today: not a card, not an investment. */
export const isLiquid = (a: Account): boolean => a.type === 'checking' || a.type === 'savings' || a.type === 'cash'
/**
 * Money meant for spending: checking and cash. Savings is liquid but kept, so
 * safe to spend and the cash line leave it out (the owner's rule, 2026-09-23)
 * and the accounts total, `liquid`, still counts it.
 */
export const isSpendable = (a: Account): boolean => a.type === 'checking' || a.type === 'cash'

/** The accounts a total counts: live, not archived. */
export const countable = (accounts: readonly Account[]): Account[] => accounts.filter(a => !a.deletedAt && !a.archivedAt)

// ---- what an account is -------------------------------------------------------
//
// Checking, savings, cash and a card are types. A brokerage, a 401(k), a coin
// wallet and an HSA are all `type: 'investment'` with what each holds beside
// it (types.ts AccountHolding), because a phone on an older build reads a type
// it does not know as checking and would count a 401(k) as money to spend.
// The picker offers the nine as one list; this is where a choice becomes a
// type and a holding, and where an account says which it is.

/** What an account is added as: a type, or for an investment what it holds. */
export type AccountKind = Exclude<AccountType, 'investment'> | AccountHolding
/** The picker's order: money to spend, money kept, what is owed, then what is invested. */
export const ACCOUNT_KINDS: readonly AccountKind[] = ['checking', 'savings', 'cash', 'credit', 'stocks', 'retirement', 'crypto', 'hsa', 'other']

const isHolding = (kind: AccountKind): kind is AccountHolding => kind in HOLDING_META

/** The type and holding a kind is written as: an investment's kind is its holding, never a type of its own. */
export function kindParts(kind: AccountKind): { type: AccountType; holding?: AccountHolding } {
  return isHolding(kind) ? { type: 'investment', holding: kind } : { type: kind }
}

/** An account's kind; null for an investment nobody has said the holding of yet. */
export function kindOf(a: Pick<Account, 'type' | 'holding'>): AccountKind | null {
  return a.type === 'investment' ? (a.holding ?? null) : a.type
}

/** A kind in a word or two, as the picker names it: "Checking", "Retirement". */
export const kindLabel = (kind: AccountKind): string => (isHolding(kind) ? HOLDING_META[kind].short : ACCOUNT_TYPE_META[kind].label)
/** …and in full, where there is room to say what it covers: "Retirement (401(k), IRA)". */
export const kindName = (kind: AccountKind): string => (isHolding(kind) ? HOLDING_META[kind].label : ACCOUNT_TYPE_META[kind].label)
/** A kind's emoji, as text; on screen, finance/KindMark.tsx draws crypto's as a gold ₿ coin instead. */
export const kindEmoji = (kind: AccountKind): string => (isHolding(kind) ? HOLDING_META[kind].emoji : ACCOUNT_TYPE_META[kind].emoji)

/** What an account is, after its name: "Retirement", or "Investment" for one whose holding is not written yet. */
export function accountKindLabel(a: Pick<Account, 'type' | 'holding'>): string {
  const kind = kindOf(a)
  return kind ? kindLabel(kind) : ACCOUNT_TYPE_META.investment.label
}

/** The account as another kind: an investment's holding goes when it stops being one. */
export function withKind(a: Account, kind: AccountKind): Account {
  const { holding: _was, ...rest } = a
  return { ...rest, ...kindParts(kind) }
}

/** What adding an account is filled in with: its kind, its name, whose it is, and what it holds today, if that was typed. */
export interface NewAccount {
  kind: AccountKind
  name: string
  memberId?: string
  /** Today's balance; on a card, what is owed on it. */
  balance?: number
}

/**
 * A new account, or null without a name. It is never called after its kind:
 * that is how two investments came to be two rows called "Investment", and
 * nothing could tell a 401(k) from a coin wallet.
 */
export function accountFromForm(f: NewAccount, o: { id: string; now: string; today: string }): Account | null {
  const name = f.name.trim()
  if (!name) return null
  const account: Account = { kind: 'account', id: o.id, name, ...kindParts(f.kind), ...(f.memberId ? { memberId: f.memberId } : {}), balances: [], createdAt: o.now, updatedAt: o.now }
  if (f.balance === undefined || !Number.isFinite(f.balance)) return account
  return withBalance(account, isLiability(account) ? Math.abs(f.balance) : f.balance, o.today)
}

export interface MoneyTotals {
  /** Everything owned less everything owed. */
  net: number
  /** What you could spend today: checking, savings and cash. */
  liquid: number
  /** What is meant for spending: checking and cash, not savings (isSpendable). */
  spendable: number
  /** What is owed on cards. A positive number. */
  owed: number
  /** Accounts with no balance typed in yet: the figures above simply do not include them. */
  unknown: number
  /** The oldest of the check-ins the totals are built from — how stale the picture is. */
  asOf: string | null
  /**
   * The NEWEST check-in on checking and cash: the day safe to spend counts
   * from (the one rule, below). An account left further behind than a week is
   * stale (staleSpendable), and counts as it stands.
   */
  spendableAsOf: string | null
}

/**
 * What the household has, from the newest check-in on each account.
 *
 * `asOf` is the OLDEST of those, not the newest, and deliberately: a total
 * built from one balance typed this morning and one from March is only as
 * good as March. The view says so rather than implying the whole picture is
 * fresh.
 *
 * `spendableAsOf` is the newest on checking and cash, and as deliberately: it
 * is the day the forecast counts bills and paydays from, and counting from a
 * wallet last touched in June would put every rent and paycheck since June on
 * top of a checking balance that already has them.
 */
export function moneyTotals(accounts: readonly Account[]): MoneyTotals {
  let net = 0
  let liquid = 0
  let spendable = 0
  let owed = 0
  let unknown = 0
  let asOf: string | null = null
  let spendableAsOf: string | null = null
  for (const a of countable(accounts)) {
    const b = latestBalance(a)
    if (!b) {
      unknown += 1
      continue
    }
    if (isLiability(a)) {
      owed += b.amount
      net -= b.amount
    } else {
      net += b.amount
      if (isLiquid(a)) liquid += b.amount
    }
    if (isSpendable(a)) {
      spendable += b.amount
      if (!spendableAsOf || b.on > spendableAsOf) spendableAsOf = b.on
    }
    if (!asOf || b.on < asOf) asOf = b.on
  }
  const round = (n: number) => Math.round(n * 100) / 100
  return { net: round(net), liquid: round(liquid), spendable: round(spendable), owed: round(owed), unknown, asOf, spendableAsOf }
}

/** Checking or cash left out of the newest check-in: its balance, as it stands, and the day it was typed in. */
export interface StaleBalance {
  account: Account
  /** Its newest check-in, YYYY-MM-DD: more than STALE_DAYS before the newest on checking and cash. */
  on: string
}

/**
 * The checking and cash accounts checked in more than STALE_DAYS before the
 * newest check-in on any of them (`asOf`, moneyTotals' spendableAsOf): left
 * out of the check-ins since. What each holds still counts, as it stands —
 * the money is still there — and Finance names each one beside safe to spend
 * and on its chip, with the way to Check in. Oldest first.
 */
export function staleSpendable(accounts: readonly Account[], asOf: string | null = moneyTotals(accounts).spendableAsOf): StaleBalance[] {
  if (!asOf) return []
  return countable(accounts)
    .filter(isSpendable)
    .flatMap(account => {
      const b = latestBalance(account)
      return b && daysBetween(b.on, asOf) > STALE_DAYS ? [{ account, on: b.on }] : []
    })
    .sort((a, b) => a.on.localeCompare(b.on) || a.account.name.localeCompare(b.account.name))
}

export type AccountGroupKey = 'spending' | 'savings' | 'investments' | 'owed'

/** One of Manage's groups of accounts: which they are, and what they come to between them. */
export interface AccountGroup {
  key: AccountGroupKey
  label: string
  accounts: Account[]
  /** What they hold between them (for Owed, what is owed on them), by moneyTotals: the figure its own total would give. */
  total: number
  /** Whether any of them has a balance typed in: with none, there is no total to show. */
  checked: boolean
}

const GROUPS: { key: AccountGroupKey; label: string; has(a: Account): boolean; total(t: MoneyTotals): number }[] = [
  { key: 'spending', label: 'Spending', has: isSpendable, total: t => t.spendable },
  { key: 'savings', label: 'Savings', has: a => a.type === 'savings', total: t => t.liquid },
  { key: 'investments', label: 'Investments', has: a => a.type === 'investment', total: t => t.net },
  { key: 'owed', label: 'Owed', has: isLiability, total: t => t.owed },
]

/**
 * The live accounts in Manage's groups — money to spend, savings,
 * investments, cards — each with its subtotal, and only the groups there are
 * accounts in. Every subtotal is moneyTotals over the group, so a group of one
 * shows exactly what its account holds and the four add up to the totals.
 */
export function accountGroups(accounts: readonly Account[]): AccountGroup[] {
  const live = countable(accounts)
  return GROUPS.flatMap(g => {
    const list = live.filter(a => g.has(a))
    return list.length ? [{ key: g.key, label: g.label, accounts: list, total: g.total(moneyTotals(list)), checked: list.some(a => !!latestBalance(a)) }] : []
  })
}

// ---- the one rule -------------------------------------------------------------
//
// The balance you checked in is the truth on its day. Every bill, payday and
// set-aside dated AFTER that day counts: money in and money out alike, done or
// not. Anything dated on or before it is already in the balance.
//
// With checking and cash checked in on different days, that day is the NEWEST
// of their check-ins. Check in types every account at once, so the newest is
// the one the bills and paydays since have gone through; an account left out
// of it counts as it stands, since its money is still there. One left behind
// by more than STALE_DAYS is stale (staleSpendable), and Finance says so
// beside safe to spend and on its chip rather than guessing at it. Counting
// from the OLDEST, as this once did, put everything since a wallet was last
// touched on top of a checking balance typed this morning: an $80 wallet from
// June counted every rent and paycheck since June a second time.
//
// The timeline used to take the bills off and never put a payday on. A payday
// due today or already gone by was left out while an overdue bill came off,
// and a series counted its one open occurrence alone, so a fortnightly wage
// landed once in 30 days and next month's rent not at all. Leaving bills out
// is not a floor, it is a guess on the bright side. Now safe to spend, the cash
// line, Coming up and the 60 days under Accounts are all read off one list
// (moneyForecast), built here and nowhere else.
//
// An occurrence's date is its due day, never the day it was ticked off: a
// paycheck already in Friday's balance that gets its "Got it" on Saturday is
// still Thursday's, and counting it on Saturday would count it twice. One
// dated after the check-in and already past lands on today: it has happened,
// or is owed or expected, since. A done one counts what was paid (Paid, or the
// amount due when nothing was typed, as withPaidDefault records it) and the
// rest the amount due; one with no amount is listed and never counted.
//
// A repeat counts every time it lands. Each series is stepped on from the
// latest occurrence that carries the repeat — the open one, or the last done
// one when none open does — with stepDue, the step nextOccurrence takes when
// one is ticked off, so these are the days the real occurrences will have.
// That goes for an open one whose day has gone as well: a rent paid by
// autopay, or a wage paid in, that nobody ticks off still comes round next
// time. The ones a repeat brings are expected, not tasks: Coming up draws them
// lighter, with nothing to tick.
//
// Every open occurrence counts on its own day. One ticked off hands its repeat
// on to the next and keeps none, so a payday marked received early and then
// reopened is an occurrence of its own beside the next, which carries the
// repeat now: both count, and the series steps on from the second. Only two
// open copies that BOTH carry the repeat are one occurrence, ticked off on two
// devices before they met, and the first of them is kept.

const round = (n: number) => Math.round(n * 100) / 100

/** How many bills, paydays and set-asides: what a figure counted, or had to leave out. */
export interface MoneyCounts {
  bills: number
  paydays: number
  setAsides: number
}

const noCounts = (): MoneyCounts => ({ bills: 0, paydays: 0, setAsides: 0 })
const tally = (counts: MoneyCounts, r: { income: boolean; saving: boolean }) => {
  if (r.income) counts.paydays += 1
  else if (r.saving) counts.setAsides += 1
  else counts.bills += 1
}

/**
 * One bill, payday or set-aside on its day, as the timeline reads it: an
 * occurrence written down, open or done, or one its repeat will bring.
 */
export interface MoneyRow {
  /** The task: for a projected one, the occurrence of its series it was stepped on from. */
  task: Task & { bill: Bill }
  /** YYYY-MM-DD it is due. */
  due: string
  /** YYYY-MM-DD it counts on: its due day, or today for one that has gone by since the check-in. */
  day: string
  /** Still open, and its day is over (shared/due.mts: a day is overdue once it has gone). */
  overdue: boolean
  income: boolean
  saving: boolean
  /** What it counts: a done one what was paid, the rest the amount due. Undefined with no amount: listed, never counted. */
  amount?: number
  /** Not a task yet: its repeat brings it. Expected, and nothing to tick. */
  projected: boolean
  /** Ticked off: counted when it is dated after the check-in, and never listed. */
  done: boolean
  /** Dated on or before the check-in, so the balance already has it and nothing counts it again. */
  inBalance: boolean
}

/** One day on the spendable line: what moved on it, and where that left checking and cash. */
export interface MoneyDay {
  day: string
  /** Positive in, negative out. */
  change: number
  /** Running spendable balance (checking and cash) at the end of that day. */
  balance: number
  rows: { title: string; amount: number; income: boolean; saving?: boolean; projected?: boolean; task: Task & { bill: Bill } }[]
}

/** The day an occurrence is due on this device's calendar; null with no date, or one that is not a date. */
const dueDay = (dueAt: string | undefined): string | null => {
  if (!dueAt) return null
  const at = new Date(dueAt)
  return Number.isNaN(at.getTime()) ? null : dateKey(at)
}

/** What an occurrence counts: a done one what was paid (withPaidDefault's rule), any other the amount due. */
const amountOf = (t: Task, done: boolean): number | undefined => {
  const n = done ? (t.actualCost ?? t.estimateCost) : t.estimateCost
  return n !== undefined && Number.isFinite(n) ? n : undefined
}

/**
 * The days a series falls due, from `task`'s own due day up to `through`, that
 * day included: stepped on from its due date with stepDue, keeping the day a
 * bill remembers, exactly as nextOccurrence steps the real ones. Empty for one
 * with no date or due after `through`; its own day alone when it does not
 * repeat. For money, whose repeats keep their day: a chore's comes round from
 * when it was done instead.
 */
export function seriesDays(task: Pick<Task, 'dueAt' | 'recurrence' | 'bill'>, through: string, cap = 10_000): string[] {
  if (!task.dueAt) return []
  let at = new Date(task.dueAt)
  if (Number.isNaN(at.getTime())) return []
  const freq = task.recurrence?.freq
  let day = task.bill && Number.isInteger(task.bill.day) ? task.bill.day : undefined
  const days: string[] = []
  for (let key = dateKey(at), i = 0; key <= through; i++) {
    days.push(key)
    if (!freq || i >= cap) break
    const next = stepDue(at, freq, day)
    at = next.at
    day = next.day
    key = dateKey(at)
  }
  return days
}

/** Everything the timeline counts and lists, for one window: the one rule, worked through. */
export interface MoneyForecast {
  /** Today, and the last day it looks at: YYYY-MM-DD. */
  today: string
  through: string
  /** What checking and cash held when checked in (never savings): each as it stands, a stale one's included. */
  checkedIn: number
  /** The day that was true: the newest of their check-ins (moneyTotals). Null with none, and then nothing counts. */
  asOf: string | null
  /** Checking and cash left out of the check-ins since, by more than STALE_DAYS: counted as they stand, and said. */
  stale: StaleBalance[]
  /** Every occurrence up to `through`, open, done and projected, in Coming up's order: overdue first, then by day, money in before money out. */
  rows: MoneyRow[]
  /** Open bills, paydays and set-asides with no date: never counted, and never dropped. */
  undated: (Task & { bill: Bill })[]
  /** The end of each day something counts on, from the balance checked in: today first, for what has gone by since. */
  days: MoneyDay[]
  /** The end of today: the check-in, and what has fallen due since. */
  now: number
  /** The lowest point from today to `through`, today's included, and the first day it gets there. */
  low: { day: string; balance: number }
  high: number
  /** The first day it goes below zero, today included. */
  short: { day: string; balance: number } | null
  /** What it counted, done or not, money in and out alike. */
  counted: MoneyCounts
  /** Occurrences it would count with no amount written down. */
  unpriced: number
  /** Accounts nobody has typed a balance into: not in any figure. */
  unchecked: number
}

const byTitle = (a: MoneyRow, b: MoneyRow) => (a.task.title || '').localeCompare(b.task.title || '') || a.task.id.localeCompare(b.task.id)
const paydaysFirst = (a: Task, b: Task) => Number(isPayday(b)) - Number(isPayday(a)) || (a.title || '').localeCompare(b.title || '') || a.id.localeCompare(b.id)

/**
 * The money timeline from the balance checked in to `days` from today, by the
 * one rule above: every figure Finance shows is read off this.
 *
 * Open is to do, doing or blocked: one still on the Wishlist, or cancelled, is
 * not money anybody owes or is owed (the rule the Stats lens and the month of
 * bills keep). A series is its occurrences' shared id (seriesRoot, as
 * savedSoFar reads it), so two open copies of one that both carry the repeat,
 * ticked off on two devices, count once, and a day it already has written
 * down is never projected over.
 */
export function moneyForecast(accounts: readonly Account[], tasks: readonly Task[], days: number, now: Date): MoneyForecast {
  const today = dateKey(now)
  const through = shiftDayKey(today, days)
  const totals = moneyTotals(accounts)
  const asOf = totals.spendableAsOf
  const inBalance = (due: string) => asOf !== null && due <= asOf
  const row = (task: Task & { bill: Bill }, due: string, how: 'open' | 'done' | 'projected'): MoneyRow => ({
    task,
    due,
    day: due < today ? today : due,
    // the one overdue rule (shared/due.mts): its day is over, whatever its time
    overdue: how === 'open' && isOverdue(task.dueAt, now),
    income: isPayday(task),
    saving: isSaving(task),
    amount: amountOf(task, how === 'done'),
    projected: how === 'projected',
    done: how === 'done',
    inBalance: inBalance(due),
  })

  const rows: MoneyRow[] = []
  const undated: (Task & { bill: Bill })[] = []
  type Dated = { task: Task & { bill: Bill }; due: string }
  const series = new Map<string, { open: Dated[]; last?: Dated; days: Set<string> }>()
  for (const t of tasks) {
    if (!isMoney(t)) continue
    const done = t.status === 'done'
    if (!done && !OPEN_STATUSES.includes(t.status)) continue
    const due = dueDay(t.dueAt)
    if (!due) {
      if (!done) undated.push(t)
      continue
    }
    const root = seriesRoot(t.id)
    let s = series.get(root)
    if (!s) series.set(root, (s = { open: [], days: new Set() }))
    s.days.add(due)
    if (done) {
      // what a series that has run out of open ones still repeats from
      if (t.recurrence && (!s.last || due > s.last.due)) s.last = { task: t, due }
      if (due <= through && !inBalance(due)) rows.push(row(t, due, 'done'))
    } else s.open.push({ task: t, due })
  }
  for (const s of series.values()) {
    // every open occurrence on its own day; of the ones carrying the repeat,
    // the first alone — the others are it again, ticked off on another device
    let repeats: Dated | undefined
    for (const o of s.open.sort((a, b) => a.due.localeCompare(b.due) || a.task.id.localeCompare(b.task.id))) {
      if (o.task.recurrence) {
        if (repeats) continue
        repeats = o
      }
      if (o.due <= through) rows.push(row(o.task, o.due, 'open'))
    }
    // stepped on from the latest occurrence that still repeats
    const from = repeats && (!s.last || repeats.due >= s.last.due) ? repeats.task : s.last?.task
    if (!from?.recurrence) continue
    for (const due of seriesDays(from, through).slice(1)) {
      if (s.days.has(due) || inBalance(due)) continue
      // with nothing checked in, a repeat's past has nothing to count against
      if (asOf === null && due < today) continue
      rows.push(row(from, due, 'projected'))
    }
  }
  rows.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.due.localeCompare(b.due) || Number(b.income) - Number(a.income) || Number(a.projected) - Number(b.projected) || byTitle(a, b))

  // the line: with no balance for checking or cash there is nothing to count from
  const counted = noCounts()
  let unpriced = 0
  const out: MoneyDay[] = []
  if (asOf !== null) {
    const byDay = new Map<string, MoneyDay['rows']>()
    for (const r of rows) {
      if (r.inBalance) continue
      if (r.amount === undefined) {
        if (!r.done) unpriced += 1
        continue
      }
      tally(counted, r)
      const list = byDay.get(r.day) ?? []
      list.push({
        title: r.task.title || (r.income ? 'Payday' : r.saving ? 'Savings' : 'Bill'),
        amount: r.amount,
        income: r.income,
        ...(r.saving ? { saving: true } : {}),
        ...(r.projected ? { projected: true } : {}),
        task: r.task,
      })
      byDay.set(r.day, list)
    }
    let balance = totals.spendable
    for (const day of [...byDay.keys()].sort()) {
      const list = byDay.get(day)!
      const change = list.reduce((n, r) => n + (r.income ? r.amount : -r.amount), 0)
      balance = round(balance + change)
      out.push({ day, change: round(change), balance, rows: list })
    }
  }
  const start = out[0]?.day === today ? out[0].balance : round(totals.spendable)
  let low = { day: today, balance: start }
  let high = start
  let short = start < 0 ? { day: today, balance: start } : null
  for (const d of out) {
    if (d.day === today) continue
    if (d.balance < low.balance) low = { day: d.day, balance: d.balance }
    if (d.balance > high) high = d.balance
    if (!short && d.balance < 0) short = { day: d.day, balance: d.balance }
  }
  return {
    today,
    through,
    checkedIn: totals.spendable,
    asOf,
    stale: staleSpendable(accounts, asOf),
    rows,
    undated: undated.sort(paydaysFirst),
    days: out,
    now: start,
    low,
    high,
    short,
    counted,
    unpriced,
    unchecked: totals.unknown,
  }
}

/**
 * Spendable cash (checking and cash, not savings) at the end of each day
 * something counts on, from the balance checked in to `days` from today, by
 * the one rule above. A set-aside goes OUT here: it is money moved to where it
 * will not be spent, which is exactly what this is about, even though no
 * figure calls it spending. Empty until checking or cash has a balance.
 */
export function cashRunway(accounts: readonly Account[], tasks: readonly Task[], days = 60, now = new Date()): MoneyDay[] {
  return moneyForecast(accounts, tasks, days, now).days
}

/** The first day the runway goes below zero, and by how much. Null when it never does. */
export function firstShortfall(runway: readonly MoneyDay[]): { day: string; balance: number } | null {
  const hit = runway.find(d => d.balance < 0)
  return hit ? { day: hit.day, balance: hit.balance } : null
}

/** "Maria · every 2 weeks · $1,840" — one payday, as a row reads it. */
export function paydayLine(t: Task, nameOf: (id: string | undefined) => string | null): string {
  const who = nameOf(t.bill?.forMemberId)
  return [who, t.bill?.payee, t.estimateCost !== undefined ? formatMoney(t.estimateCost) : ''].filter(Boolean).join(' · ')
}

/** "On Fri, Oct 3 the money you can actually spend goes to −$310.00 — counting only what is written down." */
export function shortfallLine(short: { day: string; balance: number }, dayLabel: (day: string) => string): string {
  return `On ${dayLabel(short.day)} the money you can actually spend goes to ${formatMoney(short.balance)} — counting only what is written down.`
}

// ---- the timeline -------------------------------------------------------------
//
// Finance opens on one question: how much can we spend today and still cover
// everything coming? Everything below is the arithmetic behind that screen,
// pure, so the view only draws it, and all of it is moneyForecast's: the
// balances from moneyTotals, the money in and out by the one rule, a series'
// progress from what its finished occurrences paid (bills.ts). Nothing here
// counts a thing a second way.

/** How far safe to spend, Coming up and the cash line look (the line goes to 60 at a tap). */
export const TIMELINE_DAYS = 30

/** Whether any account meant for spending has a balance typed in: without one there is nothing to count from. */
export const hasSpendableBalance = (accounts: readonly Account[]): boolean => countable(accounts).some(a => isSpendable(a) && !!latestBalance(a))

export interface SafeToSpend {
  /**
   * The lowest the spendable line goes in the next TIMELINE_DAYS, today's
   * point included: the most that could go today with everything dated in
   * that time still covered, counting the paydays that land before each bill.
   * Null with no balance typed in for checking or cash.
   */
  amount: number | null
  /** What checking and cash held when checked in (never savings). */
  spendable: number
  /** The newest check-in on those accounts (moneyTotals): the day it counts from, and how old the figure is. */
  asOf: string | null
  /** Checking and cash left out of the check-ins since by more than STALE_DAYS: in the figure as they stand, and named under it. */
  stale: StaleBalance[]
  /** The day the line is lowest, YYYY-MM-DD: the first day it gets there, and today when nothing takes it lower. */
  low: string
  /** The first payday after that day in the window: the one the low point comes before. */
  before: MoneyRow | null
  /** With no payday after it: the biggest bill or set-aside on that day, the one that takes the line down there. */
  after?: MoneyRow | null
  /** The first day in the window the line goes below zero, today included (moneyForecast's). */
  short?: { day: string; balance: number } | null
  /** The last day it counts, YYYY-MM-DD: TIMELINE_DAYS on. */
  through: string
  /** What it counted in that time, done or not: how many bills, paydays and set-asides. */
  bills: number
  paydays: number
  setAsides: number
  /** Ones in that time with no amount written down: listed, not counted. */
  unpriced: number
  /** Open ones with no date at all: listed under Needs a date, not counted. */
  undated: MoneyCounts
  /** Accounts nobody has typed a balance into: not in the figure at all. */
  unchecked: number
}

/**
 * Safe to spend: the lowest point of the spendable line over the next
 * TIMELINE_DAYS, today's included. Spending that much today still leaves
 * enough for every bill and set-aside dated in the window, with each payday
 * counted on the day it lands, so a rent due the day after a paycheck is
 * covered by it and one due the day before is not. Below zero, it is what is
 * missing on the worst day.
 */
export function safeToSpend(accounts: readonly Account[], tasks: readonly Task[], now: Date): SafeToSpend {
  const f = moneyForecast(accounts, tasks, TIMELINE_DAYS, now)
  const undated = noCounts()
  for (const t of f.undated) tally(undated, { income: isPayday(t), saving: isSaving(t) })
  // what the low day took out, when it took the line down at all
  const fell = (f.days.find(d => d.day === f.low.day)?.change ?? 0) < 0
  const out = fell ? f.rows.filter(r => r.day === f.low.day && !r.income && !r.inBalance && r.amount !== undefined) : []
  return {
    amount: f.asOf === null ? null : f.low.balance,
    spendable: f.checkedIn,
    asOf: f.asOf,
    stale: f.stale,
    low: f.low.day,
    before: f.rows.find(r => r.income && !r.inBalance && r.amount !== undefined && r.day > f.low.day) ?? null,
    after: out.reduce<MoneyRow | null>((big, r) => (!big || r.amount! > big.amount! ? r : big), null),
    short: f.short,
    through: f.through,
    bills: f.counted.bills,
    paydays: f.counted.paydays,
    setAsides: f.counted.setAsides,
    unpriced: f.unpriced,
    undated,
    unchecked: f.unchecked,
  }
}

/** "4 bills, 3 paydays and 1 set-aside": the kinds there are any of, in that order. Empty with none. */
export function countsList(c: MoneyCounts): string {
  const of = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)
  const parts = [c.bills ? of(c.bills, 'bill', 'bills') : '', c.paydays ? of(c.paydays, 'payday', 'paydays') : '', c.setAsides ? of(c.setAsides, 'set-aside', 'set-asides') : ''].filter(Boolean)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}

/**
 * What safe to spend is, under the figure: "Lowest on Wed, Sep 30, before
 * Maria’s pay · counts 5 bills and 4 paydays through Oct 23". A payday is
 * named only when one comes after the low point in the window, the one that
 * lifts the line again; otherwise the day alone.
 */
export function safeLine(s: SafeToSpend, today: string, say: { day(key: string): string; short(key: string): string; payday(row: MoneyRow): string }): string {
  const counted = countsList(s)
  if (!counted) return `Nothing falls due through ${say.short(s.through)}`
  return `${lowWhen(s, today, say)} · counts ${counted} through ${say.short(s.through)}`
}

/** "Lowest on Thu, Oct 1, before Maria’s pay": the day, and the payday that lifts the line after it. */
function lowWhen(s: SafeToSpend, today: string, say: { day(key: string): string; payday(row: MoneyRow): string }): string {
  const when = s.low === today ? 'Lowest today' : `Lowest on ${say.day(s.low)}`
  return `${when}${s.before ? `, before ${say.payday(s.before)}` : ''}`
}

/**
 * The low point on its own, as the summary under safe to spend says it:
 * safeLine's first half, and with no payday after it in the window, what took
 * the line down there instead — "Lowest on Tue, Oct 20, after Car insurance".
 */
export function lowLine(s: SafeToSpend, today: string, say: { day(key: string): string; short(key: string): string; payday(row: MoneyRow): string; bill(row: MoneyRow): string }): string {
  if (!countsList(s)) return `Nothing falls due through ${say.short(s.through)}`
  const low = lowWhen(s, today, say)
  return !s.before && s.after ? `${low}, after ${say.bill(s.after)}` : low
}

/** "2 paydays have no date, so they aren’t counted yet." Null when every one has a date. */
export function undatedLine(u: MoneyCounts): string | null {
  const n = u.bills + u.paydays + u.setAsides
  if (!n) return null
  return `${countsList(u)} ${n === 1 ? 'has no date, so it isn’t counted yet' : 'have no date, so they aren’t counted yet'}.`
}

/** The cash line: checking and cash from the end of today, then each day something counts on, as far as it looks. */
export interface CashLine {
  /** Today and the last day drawn, YYYY-MM-DD. */
  from: string
  to: string
  /** Where the line starts: the end of today, with what has gone by since the check-in counted in. */
  start: number
  /** The end of each day after today that something counts on (moneyForecast). */
  days: MoneyDay[]
  /** The lowest the line goes, and the first day it gets there; today when nothing takes it lower. Over 30 days, it is safe to spend. */
  low: { day: string; balance: number }
  high: number
  /** The first day it goes under, today included, in firstShortfall's words. */
  short: { day: string; balance: number } | null
}

/** The cash line for `days` ahead (30, or 60 at a tap), or null with no spendable balance to start it from. */
export function cashLine(accounts: readonly Account[], tasks: readonly Task[], days: number, now: Date): CashLine | null {
  const f = moneyForecast(accounts, tasks, days, now)
  if (f.asOf === null) return null
  return { from: f.today, to: f.through, start: f.now, days: f.days.filter(d => d.day > f.today), low: f.low, high: f.high, short: f.short }
}

/** Coming up: the money with no date, and every open or expected occurrence in the next TIMELINE_DAYS. */
export interface ComingUp {
  /** Listed first, under Needs a date: nothing counts one until it has a date. */
  undated: (Task & { bill: Bill })[]
  /** Open ones, overdue first, and what their repeats bring. A done one counts but is not listed. */
  rows: MoneyRow[]
}

export function comingUp(accounts: readonly Account[], tasks: readonly Task[], now: Date): ComingUp {
  const f = moneyForecast(accounts, tasks, TIMELINE_DAYS, now)
  return { undated: f.undated, rows: f.rows.filter(r => !r.done) }
}

// ---- pay periods --------------------------------------------------------------
//
// Finance opens on the money cut at each payday: what each paycheck has to
// cover before the next one lands, and what is left when it does. Nothing here
// counts anything a second time. A period is a stretch of the forecast's own
// rows, from one payday's day to the day before the next, and what is left at
// its end is the forecast's own line on that day. A bill due on a payday is
// that payday's to cover: the forecast counts money in before money out on a
// day, and the line at the end of the day has both in it.

/** One payday's stretch of the forecast, or Now: what falls due before the first payday. */
export interface PayPeriod {
  /** 'now', or the day its paydays land. */
  key: string
  /** The paydays that open it, all on one day, counted or not yet priced; none for Now. */
  paydays: MoneyRow[]
  /** The first and last days in it: today (Now) or the paydays' day, to the day before the next ones or the window's last. */
  from: string
  to: string
  /** The paydays that open the next period: what "Left before" names. None for the last. */
  next: MoneyRow[]
  /** What it lists, in Coming up's order: its bills and set-asides open or expected, and a payday still open in the balance. Never a done one. */
  rows: MoneyRow[]
  /** What its paydays bring in, and what its bills and set-asides take: the rows the forecast counts, done ones included. */
  pay: number
  out: number
  /** How much of the pay they take, in whole percent; null with no pay to take it from. */
  share: number | null
  /** The spendable line at the end of its last day, off the forecast; null with nothing checked in. */
  left: number | null
}

/** The spendable line at the end of `day`: the forecast's running balance, or the check-in before anything moved it. Null with nothing checked in. */
export function balanceAt(f: MoneyForecast, day: string): number | null {
  if (f.asOf === null) return null
  let balance = f.checkedIn
  for (const d of f.days) {
    if (d.day > day) break
    balance = d.balance
  }
  return balance
}

/**
 * The forecast as pay periods: Now, when anything falls due before the first
 * payday in the window, then one period for each day a payday lands, real or
 * one its repeat brings. A payday already in the balance opens nothing: its
 * money is in the check-in, so it is listed where its day falls, to be ticked
 * off, and counted nowhere.
 */
export function payPeriods(f: MoneyForecast): PayPeriod[] {
  const counts = (r: MoneyRow) => !r.inBalance && r.amount !== undefined
  const byDay = new Map<string, MoneyRow[]>()
  for (const r of f.rows) {
    if (!r.income || r.inBalance) continue
    const list = byDay.get(r.day) ?? []
    list.push(r)
    byDay.set(r.day, list)
  }
  const starts = [...byDay.keys()].sort()
  const open: { key: string; from: string; paydays: MoneyRow[] }[] = starts.map(day => ({ key: day, from: day, paydays: byDay.get(day)! }))
  if (!starts.length || starts[0] > f.today) open.unshift({ key: 'now', from: f.today, paydays: [] })
  const out: PayPeriod[] = []
  open.forEach((p, i) => {
    const next = open[i + 1]
    const to = next ? shiftDayKey(next.from, -1) : f.through
    const inIt = f.rows.filter(r => r.day >= p.from && r.day <= to && !p.paydays.includes(r))
    const rows = inIt.filter(r => !r.done)
    if (p.key === 'now' && !rows.length) return
    const pay = round(p.paydays.filter(counts).reduce((n, r) => n + r.amount!, 0))
    const spent = round(inIt.filter(r => !r.income && counts(r)).reduce((n, r) => n + r.amount!, 0))
    out.push({
      key: p.key,
      paydays: p.paydays,
      from: p.from,
      to,
      next: next?.paydays ?? [],
      rows,
      pay,
      out: spent,
      share: pay > 0 ? Math.round((spent / pay) * 100) : null,
      left: balanceAt(f, to),
    })
  })
  return out
}

/** A kind of money as Manage lists it: each series once, by its open occurrence. */
export interface MoneySeries {
  /** With a date, soonest first. */
  dated: (Task & { bill: Bill })[]
  /** With none: listed first, under Needs a date. */
  undated: (Task & { bill: Bill })[]
  /** Archived (cancelled): counted nowhere and kept, newest first; a series still running is never among them. */
  archived: (Task & { bill: Bill })[]
}

/**
 * Bills, paydays or set-asides (`pick`) as series, the way Manage lists them:
 * one row a series (seriesRoot), by its soonest open occurrence, so two open
 * copies of one ticked off on two devices are one row.
 */
export function moneySeries(tasks: readonly Task[], pick: (t: Task) => t is Task & { bill: Bill }): MoneySeries {
  const open = new Map<string, Task & { bill: Bill }>()
  const archived = new Map<string, Task & { bill: Bill }>()
  for (const t of tasks) {
    if (!pick(t)) continue
    const root = seriesRoot(t.id)
    if (OPEN_STATUSES.includes(t.status)) {
      const seen = open.get(root)
      if (!seen || (t.dueAt ?? '9999') < (seen.dueAt ?? '9999')) open.set(root, t)
    } else if (t.status === 'canceled') {
      const seen = archived.get(root)
      if (!seen || t.updatedAt > seen.updatedAt) archived.set(root, t)
    }
  }
  const all = [...open.values()]
  const byDue = (a: Task, b: Task) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '') || (a.title || '').localeCompare(b.title || '') || a.id.localeCompare(b.id)
  return {
    dated: all.filter(t => !!dueDay(t.dueAt)).sort(byDue),
    undated: all.filter(t => !dueDay(t.dueAt)).sort(paydaysFirst),
    archived: [...archived.entries()].filter(([root]) => !open.has(root)).map(([, t]) => t).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }
}

/** Whole days from one day key to another: 0 the same day, 2 for a balance typed in the day before yesterday. */
export function daysBetween(from: string, to: string): number {
  const at = (key: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN
  }
  return Math.round((at(to) - at(from)) / 86_400_000)
}

/** A week: a check-in older than this is old enough to say so. */
export const STALE_DAYS = 7

/**
 * A typed balance, or null for one that is not a number. `$1,234.56`, `1234`
 * and `-80` (an overdrawn checking account) all read; so does `(80)`, the way
 * a bank statement writes it.
 */
export function parseBalance(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const negative = /^\(.*\)$/.test(t) || /^-|^\$-|^−/.test(t)
  const n = Number(t.replace(/[^0-9.]/g, ''))
  if (!/\d/.test(t) || !Number.isFinite(n)) return null
  return round(negative ? -n : n)
}

/**
 * Whether a balance of this kind of account can be below zero: checking,
 * savings and cash can be overdrawn. A card's balance is what is owed on it,
 * always a positive number, and an investment is not drawn on.
 */
export const canBeOverdrawn = (type: AccountType): boolean => type === 'checking' || type === 'savings' || type === 'cash'

/**
 * A typed balance with its Overdrawn toggle applied. The keypad an iPhone
 * shows for an amount has no minus key, so on the phone the toggle is the
 * minus: on, the amount is below zero; off, it reads as typed — a `-80` or
 * `(80)` from a keyboard that has one is still overdrawn (parseBalance).
 */
export function signedBalance(text: string, overdrawn: boolean): number | null {
  const n = parseBalance(text)
  if (n === null || !overdrawn || n === 0) return n
  return -Math.abs(n)
}

// ---- goals --------------------------------------------------------------------

export type GoalStatus = 'reached' | 'on-track' | 'behind' | 'open'

/** A savings goal, as its card reads it: a set-aside series and what its finished occurrences paid in. */
export interface GoalView {
  /** The open occurrence: the one the next set-aside is, and whose goal is the goal. */
  task: Task & { bill: Bill }
  target: number
  by?: string
  /** What the finished set-asides of the series paid in, and how many there were. */
  saved: number
  count: number
  /** Each set-aside, and how often. */
  each?: number
  freq?: RecurrenceFreq
  /** YYYY-MM-DD of the next set-aside. */
  next?: string
  /** Set-asides still to come by `by`, the next one included. */
  left?: number
  /** Where it will be on `by` at this rate. */
  projected?: number
  /** What each set-aside would have to be to get there by `by`. */
  needed?: number
  /** Set-asides still to make at this amount, the next one included, to reach the target. */
  toGo?: number
  status: GoalStatus
  /** 0–100, of the target. */
  pct: number
}

/**
 * How many times a series falls due from its open occurrence up to and
 * including `by`: its own day and the ones seriesDays steps on to, by the
 * rule the repeat itself follows (stepDue), so a monthly one due on the 31st
 * lands where the real ones will.
 */
export function occurrencesUntil(task: Task, by: string, cap = 1000): number {
  return seriesDays(task, by, cap).length
}

/** Every savings goal with an open set-aside, soonest-due first. */
export function savingGoals(tasks: readonly Task[], now: Date): GoalView[] {
  const today = dateKey(now)
  const open = new Map<string, Task & { bill: Bill }>()
  for (const t of tasks) {
    if (!isSaving(t) || !t.bill.goal || !(t.bill.goal.target > 0) || !OPEN_STATUSES.includes(t.status)) continue
    // one card per series: two open copies (ticked off on two devices) are one goal
    const root = seriesRoot(t.id)
    const seen = open.get(root)
    if (!seen || (t.dueAt ?? '9999') < (seen.dueAt ?? '9999')) open.set(root, t)
  }
  const out: GoalView[] = []
  for (const task of open.values()) {
    const goal = task.bill.goal!
    const { saved, count } = savedSoFar(tasks, task)
    const each = task.estimateCost !== undefined && task.estimateCost > 0 ? task.estimateCost : undefined
    const next = task.dueAt ? dateKey(new Date(task.dueAt)) : undefined
    const view: GoalView = {
      task,
      target: goal.target,
      by: goal.by,
      saved,
      count,
      each,
      freq: task.recurrence?.freq,
      next,
      status: 'open',
      pct: Math.max(0, Math.min(100, Math.round((saved / goal.target) * 100))),
    }
    if (saved < goal.target && each) view.toGo = Math.ceil(round(goal.target - saved) / each)
    if (saved >= goal.target) view.status = 'reached'
    else if (goal.by) {
      const left = goal.by < today ? 0 : occurrencesUntil(task, goal.by)
      view.left = left
      view.projected = round(saved + left * (each ?? 0))
      if (left > 0) view.needed = Math.ceil(((goal.target - saved) / left) * 100) / 100
      view.status = view.projected >= goal.target ? 'on-track' : 'behind'
    }
    out.push(view)
  }
  return out.sort((a, b) => (a.next ?? '9999').localeCompare(b.next ?? '9999') || (a.task.title || '').localeCompare(b.task.title || ''))
}

// ---- the weekly check-in ------------------------------------------------------
//
// "Check in weekly" is a repeating task, not a setting of its own: a task is
// already on Home, in the reminders, on the Calendar and in the phone's own
// notifications, so the check-in is too with nothing new behind it. Its id
// starts CHECK_IN_PREFIX, which is how the app opens it on Finance's Check in
// sheet rather than in the editor, and how nextOccurrence keeps it on its
// slot — a check-in done on Saturday afternoon comes round next Sunday at six,
// not next Saturday afternoon. The slot is the open occurrence's own due time:
// moving it moves the setting, and turning it off sends the task to the Trash.

/** Sunday at six in the evening, until it is moved. */
export const CHECK_IN_DEFAULT = { weekday: 0, time: '18:00' } as const

/** The first `weekday` (0 = Sunday) at `time` (HH:MM, local) after `now`. */
export function nextSlot(now: Date, weekday: number, time: string): Date {
  const [h, m] = time.split(':').map(Number)
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number.isFinite(h) ? h : 18, Number.isFinite(m) ? m : 0, 0, 0)
  at.setDate(at.getDate() + ((weekday - at.getDay() + 7) % 7))
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 7)
  return at
}

/** The weekday and HH:MM an occurrence falls due on, on this device's clock. */
export function slotOf(dueAt: string): { weekday: number; time: string } {
  const d = new Date(dueAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { weekday: d.getDay(), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

/** The open weekly check-in of whoever is reading: theirs alone, as the reminders go by. */
export function openCheckIn(tasks: readonly Task[], myId?: string | null): Task | null {
  return (
    tasks
      .filter(t => isCheckIn(t) && !t.deletedAt && !!t.recurrence && OPEN_STATUSES.includes(t.status) && (!myId || !t.ownerId || t.ownerId === myId))
      .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))[0] ?? null
  )
}

/** The weekly check-in, first due at `at`. Private, like any new task: it is the reader's reminder. */
export function checkInTask(at: Date, o: { id: string; now: string }): Task {
  return {
    kind: 'task',
    id: `${CHECK_IN_PREFIX}${o.id}`,
    title: 'Check in your balances',
    description: 'Type in what each account holds today: Tasks → Finance → Check in. Safe to spend and the cash line are worked out from it.',
    status: 'todo',
    priority: 'normal',
    dueAt: at.toISOString(),
    recurrence: { freq: 'weekly' },
    createdAt: o.now,
    updatedAt: o.now,
    tags: [],
    shared: false,
  }
}

/**
 * The check-in a Check in just did: the open one, when it falls due within
 * two days (a Friday-evening check-in is that Sunday's) or already has. One
 * further off is next week's, and stays for its reminder.
 */
export function checkInDone(tasks: readonly Task[], myId: string | null | undefined, now: Date): Task | null {
  const t = openCheckIn(tasks, myId)
  if (!t?.dueAt) return null
  return dateKey(new Date(t.dueAt)) <= shiftDayKey(dateKey(now), 2) ? t : null
}
