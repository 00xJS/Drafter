// What was PAID, as every figure that adds money up counts it: the Stats
// lens's Money, Insights' highlights and the monthly recap
// (netlify/functions/lib/recap.mjs). Dependency-free ESM. A module of its own
// rather than a part of money.mts, which the first paint loads with the
// Bills view's rules: only the views that count what was paid need this.

import type { Task } from '../src/types.ts'
import { isSpending, withPaidDefault } from './money.mts'

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
