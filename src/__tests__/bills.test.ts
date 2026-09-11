import { describe, expect, it } from 'vitest'
import { nextOccurrence } from '../../shared/domain.mjs'
import { sanitizeTask } from '../schema'
import { billMonth, monthlyCost, withPaidDefault } from '../bills'
import { Task } from '../types'

// A bill is a repeating task with an amount. These pin the rules that make it
// behave like a bill rather than a chore: it stays on its due day, it survives a
// sync, it records what was paid, and the month adds up.

const local = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h, 0, 0).toISOString()
const ymd = (iso: string) => {
  const d = new Date(iso)
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()]
}

const task = (over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 't1',
  title: 'Council tax',
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})
const spawn = (t: Task) => nextOccurrence(t, () => 'x') as Task

describe('a bill stays on its due day', () => {
  it('comes round on the due date however early it was paid', () => {
    const t = task({ bill: { kind: 'bill' }, recurrence: { freq: 'monthly' }, dueAt: local(2027, 1, 15), completedAt: local(2027, 1, 12), status: 'done' })
    expect(ymd(spawn(t).dueAt!)).toEqual([2027, 2, 15])
  })

  it('a chore still comes round from when it was done', () => {
    const t = task({ recurrence: { freq: 'monthly' }, dueAt: local(2027, 1, 15), completedAt: local(2027, 1, 12), status: 'done' })
    expect(ymd(spawn(t).dueAt!)).toEqual([2027, 2, 12])
  })

  it('goes 31 Jan -> 28 Feb -> 31 Mar instead of settling on the 28th', () => {
    const jan = task({ bill: { kind: 'card' }, recurrence: { freq: 'monthly' }, dueAt: local(2027, 1, 31), status: 'done' })
    const feb = spawn(jan)
    expect(ymd(feb.dueAt!)).toEqual([2027, 2, 28])
    expect(feb.bill?.day).toBe(31)
    const mar = spawn({ ...feb, status: 'done' })
    expect(ymd(mar.dueAt!)).toEqual([2027, 3, 31])
  })

  it('follows a due date the owner moved, rather than the remembered day', () => {
    const moved = task({ bill: { kind: 'bill', day: 31 }, recurrence: { freq: 'monthly' }, dueAt: local(2027, 2, 20), status: 'done' })
    const next = spawn(moved)
    expect(ymd(next.dueAt!)).toEqual([2027, 3, 20])
    expect(next.bill?.day).toBe(20)
  })

  it('repeats quarterly and yearly, clamping 29 February', () => {
    const q = task({ bill: { kind: 'bill' }, recurrence: { freq: 'quarterly' }, dueAt: local(2027, 1, 15), status: 'done' })
    expect(ymd(spawn(q).dueAt!)).toEqual([2027, 4, 15])
    const y = task({ bill: { kind: 'subscription' }, recurrence: { freq: 'yearly' }, dueAt: local(2028, 2, 29), status: 'done' })
    expect(ymd(spawn(y).dueAt!)).toEqual([2029, 2, 28])
  })

  it('no longer rolls a monthly chore from 31 January into March', () => {
    const t = task({ recurrence: { freq: 'monthly' }, dueAt: local(2027, 1, 31), completedAt: local(2027, 1, 31), status: 'done' })
    expect(ymd(spawn(t).dueAt!)).toEqual([2027, 2, 28])
  })

  it('carries the bill, the amount and the payee forward but not what was paid', () => {
    const t = task({ bill: { kind: 'card', payee: 'Amex', autopay: true }, recurrence: { freq: 'monthly' }, dueAt: local(2027, 1, 15), estimateCost: 240, actualCost: 238.5, status: 'done' })
    const next = spawn(t)
    expect(next.bill).toMatchObject({ kind: 'card', payee: 'Amex', autopay: true })
    expect(next.estimateCost).toBe(240)
    expect(next.actualCost).toBeUndefined()
  })
})

describe('the bill facet survives a sync', () => {
  it('keeps kind, payee, autopay and day', () => {
    const t = sanitizeTask({ id: 'b', title: 'Amex', bill: { kind: 'card', payee: ' Amex ', autopay: true, day: 31 } })
    expect(t?.bill).toEqual({ kind: 'card', payee: 'Amex', autopay: true, day: 31 })
  })

  it('drops an unknown kind and an impossible day rather than guessing', () => {
    expect(sanitizeTask({ id: 'b', bill: { kind: 'lottery' } })?.bill).toBeUndefined()
    expect(sanitizeTask({ id: 'b', bill: { kind: 'bill', day: 40 } })?.bill?.day).toBeUndefined()
  })

  it('keeps quarterly and yearly repeats, which used to be dropped', () => {
    expect(sanitizeTask({ id: 'b', recurrence: { freq: 'quarterly' } })?.recurrence).toEqual({ freq: 'quarterly' })
    expect(sanitizeTask({ id: 'b', recurrence: { freq: 'yearly' } })?.recurrence).toEqual({ freq: 'yearly' })
  })
})

describe('marking a bill done records what was paid', () => {
  it('uses the amount due when nothing was typed under Paid', () => {
    expect(withPaidDefault(task({ bill: { kind: 'bill' }, status: 'done', estimateCost: 165 })).actualCost).toBe(165)
  })
  it('keeps an amount the owner typed', () => {
    expect(withPaidDefault(task({ bill: { kind: 'bill' }, status: 'done', estimateCost: 165, actualCost: 150 })).actualCost).toBe(150)
  })
  it('leaves chores and unfinished bills alone', () => {
    expect(withPaidDefault(task({ status: 'done', estimateCost: 20 })).actualCost).toBeUndefined()
    expect(withPaidDefault(task({ bill: { kind: 'bill' }, status: 'todo', estimateCost: 20 })).actualCost).toBeUndefined()
  })
})

describe('the month adds up', () => {
  const now = new Date(2027, 2, 15, 12) // 15 March 2027
  const bills = [
    task({ id: 'late', bill: { kind: 'bill' }, dueAt: local(2027, 3, 10), estimateCost: 100 }),
    task({ id: 'soon', bill: { kind: 'card' }, dueAt: local(2027, 3, 28), estimateCost: 240 }),
    task({ id: 'april', bill: { kind: 'bill' }, dueAt: local(2027, 4, 2), estimateCost: 50 }),
    task({ id: 'paid', bill: { kind: 'subscription' }, status: 'done', dueAt: local(2027, 3, 1), completedAt: local(2027, 3, 1), estimateCost: 12, actualCost: 11.99 }),
    task({ id: 'chore', dueAt: local(2027, 3, 20), estimateCost: 999 }),
  ]

  it('splits the current month into overdue, upcoming and paid', () => {
    const m = billMonth(bills, new Date(2027, 2, 1), now)
    expect(m.overdue.map(t => t.id)).toEqual(['late'])
    expect(m.upcoming.map(t => t.id)).toEqual(['soon'])
    expect(m.paid.map(t => t.id)).toEqual(['paid'])
    expect(m.paidSoFar).toBe(11.99)
    expect(m.stillToPay).toBe(340)
    expect(m.total).toBe(351.99)
  })

  it('does not count what is overdue now against a future month', () => {
    const m = billMonth(bills, new Date(2027, 3, 1), now)
    expect(m.overdue).toEqual([])
    expect(m.upcoming.map(t => t.id)).toEqual(['april'])
    expect(m.stillToPay).toBe(50)
  })

  it('puts every repeating payment on one monthly figure', () => {
    const series = [
      task({ id: 'm', bill: { kind: 'bill' }, recurrence: { freq: 'monthly' }, estimateCost: 50 }),
      task({ id: 'q', bill: { kind: 'bill' }, recurrence: { freq: 'quarterly' }, estimateCost: 90 }),
      task({ id: 'y', bill: { kind: 'subscription' }, recurrence: { freq: 'yearly' }, estimateCost: 120 }),
      task({ id: 'closed', bill: { kind: 'bill' }, recurrence: { freq: 'monthly' }, estimateCost: 1000, status: 'done' }),
      task({ id: 'oneoff', bill: { kind: 'bill' }, estimateCost: 1000 }),
    ]
    expect(monthlyCost(series)).toBe(90)
  })
})
