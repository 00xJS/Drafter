import { BILL_KIND_META, Bill, OPEN_STATUSES, RecurrenceFreq, Task } from './types'

// Household payments: the rules behind the Bills view and the calendar's money
// glyphs. A bill is a task with a `bill` facet — its amount due is estimateCost
// and what was paid is actualCost — so everything here is a view over tasks.

/** Every figure in the app is stored as a plain number; this is the one place it gets a currency. */
export const CURRENCY = 'GBP'
const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY })
export const formatMoney = (n: number | undefined): string => (n === undefined || !Number.isFinite(n) ? '' : fmt.format(n))

export const isBill = (t: Task): t is Task & { bill: Bill } => !!t.bill && !t.deletedAt
export const billGlyph = (t: Task): string => (t.bill ? BILL_KIND_META[t.bill.kind].emoji : '')

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
  let total = 0
  for (const t of tasks) {
    if (!isBill(t) || !t.recurrence || !OPEN_STATUSES.includes(t.status) || t.estimateCost === undefined) continue
    total += t.estimateCost * PER_MONTH[t.recurrence.freq]
  }
  return round(total)
}

export interface BillMonth {
  /** Unpaid and past due. Only in the current month's view, where it is owed now. */
  overdue: Task[]
  /** Unpaid and due in the month (from now on, when it is the current month). */
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
  const overdue = isCurrent ? open.filter(t => at(t.dueAt) < nowMs).sort(byDue) : []
  const upcoming = open.filter(t => inMonth(t.dueAt) && (!isCurrent || at(t.dueAt) >= nowMs)).sort(byDue)
  const paid = bills
    .filter(t => t.status === 'done' && inMonth(t.completedAt))
    .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
  const paidSoFar = round(sum(paid.map(t => t.actualCost ?? t.estimateCost ?? 0)))
  const stillToPay = round(sum([...overdue, ...upcoming].map(t => t.estimateCost ?? 0)))
  return { overdue, upcoming, paid, paidSoFar, stillToPay, total: round(paidSoFar + stillToPay) }
}
