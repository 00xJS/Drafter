import { formatMoney, isPayday } from './bills'
import { ACCOUNT_TYPE_META, type Account, type BalanceCheck, type Task } from './types'
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

/** One dated money movement the forecast counts: a payday in, or a bill out. */
export interface MoneyDay {
  day: string
  /** Positive in, negative out. */
  change: number
  /** Running liquid balance at the end of that day. */
  balance: number
  rows: { title: string; amount: number; income: boolean }[]
}

/**
 * Liquid cash, day by day, from today to `days` out.
 *
 * Built from what is already written down: every open bill and payday with a
 * due date in the window, counted once, against the liquid balance as it
 * stands now. It does not invent a repeat — a series has exactly one open
 * occurrence at a time (bills.ts), so a fortnightly wage shows its next
 * payment and not the three after it. That is a floor, not a projection, and
 * it is the honest one: it can only be better than it says.
 */
export function cashRunway(accounts: readonly Account[], tasks: readonly Task[], days = 60, now = new Date()): MoneyDay[] {
  const start = dateKey(now)
  const end = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days))
  const byDay = new Map<string, { title: string; amount: number; income: boolean }[]>()
  for (const t of tasks) {
    if (!t.bill || t.deletedAt || !t.dueAt || t.status === 'done' || t.status === 'canceled') continue
    const amount = t.estimateCost
    if (amount === undefined || !Number.isFinite(amount)) continue
    const day = dateKey(new Date(t.dueAt))
    // anything already overdue is owed NOW, so it lands on today rather than in the past
    const on = day < start ? start : day
    if (on > end) continue
    const income = isPayday(t)
    const rows = byDay.get(on) ?? []
    rows.push({ title: t.title || (income ? 'Payday' : 'Bill'), amount, income })
    byDay.set(on, rows)
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
