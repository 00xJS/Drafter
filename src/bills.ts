import { BILL_KIND_META, Bill, OPEN_STATUSES, RecurrenceFreq, Task, isIncomeKind, isSavingKind } from './types'
import { isOverdue } from '../shared/due.mts'
import { seriesRoot } from '../shared/domain.mts'

// Household payments: the rules behind the Bills view and the calendar's money
// glyphs. A bill is a task with a `bill` facet — its amount due is estimateCost
// and what was paid is actualCost — so everything here is a view over tasks.

/**
 * Every figure in the app is stored as a plain number; this is the one place
 * it gets a currency: US dollars, written the en-US way ("$1,234.56") on
 * every device, whatever its language.
 */
export const CURRENCY = 'USD'
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY })
export const formatMoney = (n: number | undefined): string => (n === undefined || !Number.isFinite(n) ? '' : fmt.format(n))

/** A payment out: a bill, a card, a subscription, a loan. Never a payday, and never a set-aside, which is money kept. */
export const isBill = (t: Task): t is Task & { bill: Bill } => !!t.bill && !t.deletedAt && !isIncomeKind(t.bill.kind) && !isSavingKind(t.bill.kind)

/**
 * A payday: money coming IN, kept as a bill facet because that is exactly the
 * shape of it — a payee, an amount, a repeat and a date — and because doing so
 * puts it on the calendar, in reminders and on Today with no second machinery
 * (v3.27). Every figure that adds money up has to ask which it is, or a wage
 * reads as a cost.
 */
export const isPayday = (t: Task): t is Task & { bill: Bill } => !!t.bill && !t.deletedAt && isIncomeKind(t.bill.kind)

/**
 * A set-aside: money moved into savings on a schedule, the same facet again.
 * It leaves what can be spent, so the runway counts it going out; it is not
 * spent, so no cost, no Spend and no "paid" figure counts it (isSpending).
 */
export const isSaving = (t: Task): t is Task & { bill: Bill } => !!t.bill && !t.deletedAt && isSavingKind(t.bill.kind)

/** A bill, a payday OR a set-aside: the rows the Finance view is built from. */
export const isMoney = (t: Task): t is Task & { bill: Bill } => !!t.bill && !t.deletedAt

/**
 * Whether what a task cost is money SPENT. Any task's cost is, and a bill's
 * is; a payday's is money in, and a set-aside's is money kept. Review's Spend
 * and the Stats lens's Paid both ask this before they add anything up.
 */
export const isSpending = (t: Task): boolean => !t.bill || (!isIncomeKind(t.bill.kind) && !isSavingKind(t.bill.kind))

/** The emoji a money row shows: its own (a template's, a goal's), or its kind's. */
export const billEmoji = (bill: Pick<Bill, 'kind' | 'emoji'> | undefined): string =>
  bill?.emoji || (bill && BILL_KIND_META[bill.kind]?.emoji) || BILL_KIND_META.bill.emoji

/**
 * Marking a bill done with nothing typed under Paid records the amount due as
 * paid. That is what a swipe on Today or a drag on the board means, and it is
 * what makes the month's "paid so far" add up without a second step.
 */
export function withPaidDefault(t: Task): Task {
  return t.bill && t.status === 'done' && t.actualCost === undefined && t.estimateCost !== undefined ? { ...t, actualCost: t.estimateCost } : t
}

/** How many times each frequency falls in an average month, to put every bill on one figure. */
const PER_MONTH: Record<RecurrenceFreq, number> = {
  daily: 365 / 12,
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
}

const round = (n: number) => Math.round(n * 100) / 100
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

/**
 * What the household's repeating payments cost in an average month. Each series
 * has exactly one open occurrence at a time, so counting the open ones counts
 * every series once.
 */
export function monthlyCost(tasks: Task[]): number {
  return round(perMonth(tasks, isBill))
}

/**
 * What the household is paid in an average month, the same way: each payday
 * series counted once, at its own cadence. A fortnightly wage is 26 a year,
 * which is 2.17 a month — not 2 — so the three-payday months are already in
 * the figure rather than being a surprise twice a year.
 */
export function monthlyIncome(tasks: Task[]): number {
  return round(perMonth(tasks, isPayday))
}

/** What is left over in an average month: paid in, less paid out. Negative is the answer that matters. */
export function monthlySpare(tasks: Task[]): number {
  return round(monthlyIncome(tasks) - monthlyCost(tasks))
}

/**
 * What goes into savings in an average month, each set-aside series once at
 * its cadence. It comes out of what is left over rather than being a cost: a
 * month that sets $400 aside and has $900 spare has $500 to spend.
 */
export function monthlySetAside(tasks: Task[]): number {
  return round(perMonth(tasks, isSaving))
}

/**
 * What a set-aside series has saved so far: what each of its finished
 * occurrences paid in, found by the series' id (seriesRoot, the rule the
 * repeat machinery keeps). Paid is the amount typed under Paid, or the amount
 * due when nothing was (withPaidDefault) — what marking it done records.
 */
export function savedSoFar(tasks: readonly Task[], series: Pick<Task, 'id'>): { saved: number; count: number } {
  const root = seriesRoot(series.id)
  let saved = 0
  let count = 0
  for (const t of tasks) {
    if (t.status !== 'done' || !isSaving(t) || seriesRoot(t.id) !== root) continue
    const paid = withPaidDefault(t).actualCost
    if (paid === undefined || !Number.isFinite(paid) || paid <= 0) continue
    saved += paid
    count += 1
  }
  return { saved: round(saved), count }
}

function perMonth(tasks: Task[], pick: (t: Task) => boolean): number {
  let total = 0
  for (const t of tasks) {
    if (!pick(t) || !t.recurrence || !OPEN_STATUSES.includes(t.status) || t.estimateCost === undefined) continue
    total += t.estimateCost * PER_MONTH[t.recurrence.freq]
  }
  return total
}

export interface BillMonth {
  /** Unpaid, and its day is over (shared/due.mts). Only in the current month's view, where it is owed now. */
  overdue: Task[]
  /** Unpaid and due in the month (from today on, when it is the current month). */
  upcoming: Task[]
  /** Paid, with the payment made in the month. */
  paid: Task[]
  paidSoFar: number
  stillToPay: number
  /** The month's bills in all: what was paid plus what is still owed. */
  total: number
}

/** One month of bills, relative to `now`. */
export function billMonth(tasks: Task[], month: Date, now: Date = new Date()): BillMonth {
  const start = new Date(month.getFullYear(), month.getMonth(), 1).getTime()
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime()
  const at = (iso?: string) => (iso ? Date.parse(iso) : NaN)
  const inMonth = (iso?: string) => at(iso) >= start && at(iso) < end
  const nowMs = now.getTime()
  const isCurrent = nowMs >= start && nowMs < end
  const bills = tasks.filter(isBill)
  const open = bills.filter(t => OPEN_STATUSES.includes(t.status) && t.dueAt)
  const byDue = (a: Task, b: Task) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '')
  // Home's rule: a bill due today is today's, not overdue, until the day is out —
  // one with no time at all from 00:00, and one whose time has gone by too
  const overdue = isCurrent ? open.filter(t => isOverdue(t.dueAt, now)).sort(byDue) : []
  const upcoming = open.filter(t => inMonth(t.dueAt) && (!isCurrent || !isOverdue(t.dueAt, now))).sort(byDue)
  const paid = bills
    .filter(t => t.status === 'done' && inMonth(t.completedAt))
    .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
  const paidSoFar = round(sum(paid.map(t => t.actualCost ?? t.estimateCost ?? 0)))
  const stillToPay = round(sum([...overdue, ...upcoming].map(t => t.estimateCost ?? 0)))
  return { overdue, upcoming, paid, paidSoFar, stillToPay, total: round(paidSoFar + stillToPay) }
}
