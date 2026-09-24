import { formatMoney, isMoney, isPayday, isSaving } from './bills'
import { ACCOUNT_TYPE_META, OPEN_STATUSES, type Account, type BalanceCheck, type Bill, type Task } from './types'
import { dateKey } from './utils'

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

/** The accounts a total counts: live, not archived. */
export const countable = (accounts: readonly Account[]): Account[] => accounts.filter(a => !a.deletedAt && !a.archivedAt)

export interface MoneyTotals {
  /** Everything owned less everything owed. */
  net: number
  /** What you could spend today: checking, savings and cash. */
  liquid: number
  /** What is owed on cards. A positive number. */
  owed: number
  /** Accounts with no balance typed in yet: the figures above simply do not include them. */
  unknown: number
  /** The oldest of the check-ins the totals are built from — how stale the picture is. */
  asOf: string | null
}

/**
 * What the household has, from the newest check-in on each account.
 *
 * `asOf` is the OLDEST of those, not the newest, and deliberately: a total
 * built from one balance typed this morning and one from March is only as
 * good as March. The view says so rather than implying the whole picture is
 * fresh.
 */
export function moneyTotals(accounts: readonly Account[]): MoneyTotals {
  let net = 0
  let liquid = 0
  let owed = 0
  let unknown = 0
  let asOf: string | null = null
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
    if (!asOf || b.on < asOf) asOf = b.on
  }
  const round = (n: number) => Math.round(n * 100) / 100
  return { net: round(net), liquid: round(liquid), owed: round(owed), unknown, asOf }
}

/** One dated money movement the forecast counts: a payday in, a bill or a set-aside out. */
export interface MoneyDay {
  day: string
  /** Positive in, negative out. */
  change: number
  /** Running liquid balance at the end of that day. */
  balance: number
  rows: { title: string; amount: number; income: boolean; saving?: boolean }[]
}

/**
 * One open bill, payday or set-aside with a date, as the timeline reads it:
 * Coming up lists them, and the runway, the cash line and "safe to spend" add
 * up the ones with an amount.
 */
export interface MoneyRow {
  task: Task & { bill: Bill }
  /** YYYY-MM-DD it counts on. One already overdue is owed NOW, so it lands on today. */
  day: string
  /** YYYY-MM-DD it was due. */
  due: string
  /** Its day is over and it is still open (shared/due.mts: a day is overdue once it has gone). */
  overdue: boolean
  income: boolean
  saving: boolean
  /** Undefined when no amount is written down: such a row is listed, and never counted. */
  amount?: number
}

const byTitle = (a: MoneyRow, b: MoneyRow) => (a.task.title || '').localeCompare(b.task.title || '') || a.task.id.localeCompare(b.task.id)

/**
 * Every open bill, payday and set-aside due up to `days` from `now`, overdue
 * ones first, then by day — money in before money out on the same day, the
 * order the runway nets them in.
 *
 * Open is to do, doing or blocked: one still on the Wishlist, or cancelled, is
 * not money anybody owes (the rule the Stats lens and the month of bills keep).
 */
export function moneyRows(tasks: readonly Task[], now: Date, days: number): MoneyRow[] {
  const start = dateKey(now)
  const end = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days))
  const out: MoneyRow[] = []
  for (const t of tasks) {
    if (!isMoney(t) || !t.dueAt || !OPEN_STATUSES.includes(t.status)) continue
    const due = dateKey(new Date(t.dueAt))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) continue
    const overdue = due < start
    const day = overdue ? start : due
    if (day > end) continue
    const amount = t.estimateCost !== undefined && Number.isFinite(t.estimateCost) ? t.estimateCost : undefined
    out.push({ task: t, day, due, overdue, income: isPayday(t), saving: isSaving(t), amount })
  }
  return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.due.localeCompare(b.due) || Number(b.income) - Number(a.income) || byTitle(a, b))
}

/**
 * Liquid cash, day by day, from today to `days` out.
 *
 * Built from what is already written down: every open bill, payday and
 * set-aside with a due date in the window, counted once, against the liquid
 * balance as it stands now. A set-aside goes OUT here: it is money moved to
 * where it will not be spent, which is exactly what this is about, even though
 * no figure calls it spending. It does not invent a repeat — a series has
 * exactly one open occurrence at a time (bills.ts), so a fortnightly wage shows
 * its next payment and not the three after it. That is a floor, not a
 * projection, and it is the honest one: it can only be better than it says.
 */
export function cashRunway(accounts: readonly Account[], tasks: readonly Task[], days = 60, now = new Date()): MoneyDay[] {
  const byDay = new Map<string, MoneyDay['rows']>()
  for (const r of moneyRows(tasks, now, days)) {
    if (r.amount === undefined) continue
    const rows = byDay.get(r.day) ?? []
    rows.push({ title: r.task.title || (r.income ? 'Payday' : r.saving ? 'Savings' : 'Bill'), amount: r.amount, income: r.income, ...(r.saving ? { saving: true } : {}) })
    byDay.set(r.day, rows)
  }
  let balance = moneyTotals(accounts).liquid
  const out: MoneyDay[] = []
  for (const day of [...byDay.keys()].sort()) {
    const rows = byDay.get(day)!
    const change = rows.reduce((n, r) => n + (r.income ? r.amount : -r.amount), 0)
    balance = Math.round((balance + change) * 100) / 100
    out.push({ day, change: Math.round(change * 100) / 100, balance, rows })
  }
  return out
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
