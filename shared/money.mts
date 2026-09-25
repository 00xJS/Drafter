// Money's rules the app and the server share: how an amount is written, which
// kinds of bill are money out, and what counts as PAID. Dependency-free ESM.
// src/bills.ts and src/types.ts re-export each under the name they always had,
// so the Stats lens, Review, Finance, Insights' highlights and the monthly
// recap (netlify/functions/digest.mjs) all add money up one way.

import type { BillKind, Task } from '../src/types.ts'

/**
 * Every figure in the app is stored as a plain number; this is the one place
 * it gets a currency: US dollars, written the en-US way ("$1,234.56") on
 * every device and on the server, whatever its language.
 */
export const CURRENCY = 'USD'
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY })
export const formatMoney = (n: number | undefined): string => (n === undefined || !Number.isFinite(n) ? '' : fmt.format(n))

/** Money coming IN. Every figure that adds money up has to ask, or a payday reads as a cost. */
export const isIncomeKind = (k: BillKind | undefined): boolean => k === 'income'
/**
 * Money set aside into savings on a schedule. It leaves what you could spend
 * this month, so the runway and "safe to spend" count it going out, but it is
 * not spending: it is never a cost, a bill or money spent. Every figure that
 * adds money up has to ask this too, or a set-aside reads as a bill paid.
 */
export const isSavingKind = (k: BillKind | undefined): boolean => k === 'saving'

/**
 * Whether what a task cost is money SPENT. Any task's cost is, and a bill's
 * is; a payday's is money in, and a set-aside's is money kept. Review's Spend,
 * the Stats lens's Paid and Insights' highlights all ask this before they add
 * anything up.
 */
export const isSpending = (t: Pick<Task, 'bill'>): boolean => !t.bill || (!isIncomeKind(t.bill.kind) && !isSavingKind(t.bill.kind))

/**
 * Marking a bill done with nothing typed under Paid records the amount due as
 * paid. That is what a swipe on Today or a drag on the board means, and it is
 * what makes the month's "paid so far" add up without a second step.
 */
export function withPaidDefault<T extends Task>(t: T): T {
  return t.bill && t.status === 'done' && t.actualCost === undefined && t.estimateCost !== undefined ? { ...t, actualCost: t.estimateCost } : t
}

/** One payment: when it was made, what it came to, and who was paid. */
export interface Payment {
  at: string
  amount: number
  payee: string
}

/**
 * Everything PAID: a finished task's actual cost, filed when it was finished,
 * a bill's own amount unless you changed it (withPaidDefault), and only money
 * spent (isSpending) — a payday received and a set-aside moved are not
 * payments, and counting them made a wage read as the biggest thing you paid
 * for. Nothing in Trash, and nothing that cost nothing.
 */
export function payments(tasks: readonly Task[]): Payment[] {
  const out: Payment[] = []
  for (const raw of tasks) {
    if (raw.deletedAt || raw.status !== 'done' || !raw.completedAt || !isSpending(raw)) continue
    const t = raw.bill ? withPaidDefault(raw) : raw
    const amount = t.actualCost
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) continue
    out.push({ at: raw.completedAt, amount, payee: t.bill?.payee?.trim() || t.title || 'Untitled' })
  }
  return out
}
