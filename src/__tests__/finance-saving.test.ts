import { describe, expect, it } from 'vitest'
import { billEmoji, billMonth, isBill, isMoney, isPayday, isSaving, isSpending, monthlyCost, monthlyIncome, monthlySetAside, monthlySpare, savedSoFar, withPaidDefault } from '../bills'
import { cashRunway, withBalance } from '../finance'
import { moneyReport } from '../lensstats'
import { buildReview, weekRange } from '../review'
import { factsFor, parseQuestion, type AskSources } from '../ask'
import { sanitizeTask } from '../schema'
import { nextOccurrence } from '../../shared/domain.mts'
import type { Account, Task } from '../types'

// A set-aside is the bill facet a third way round: money moved into savings on
// a schedule. It leaves what you can spend, so the runway counts it going out;
// it is not spending, so no cost, no Spend, no "Paid" and no bill counts it.
// Every figure in the app that adds money up is held to that here, on one set
// of rows, so a new one that forgets to ask shows up as a number that moved.

const NOW = new Date(2026, 8, 21, 12, 0)
const STAMP = '2026-09-01T00:00:00.000Z'
const task = (id: string, over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id,
  title: id,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})
const at = (d: number, h = 0) => new Date(2026, 8, d, h, 0).toISOString()

const rent = task('rent', { bill: { kind: 'bill' }, estimateCost: 1200, recurrence: { freq: 'monthly' }, dueAt: at(25) })
const pay = task('pay', { bill: { kind: 'income' }, estimateCost: 2000, recurrence: { freq: 'monthly' }, dueAt: at(26) })
const fund = task('fund', { title: 'Emergency fund', bill: { kind: 'saving', emoji: '🛟', goal: { target: 1000 } }, estimateCost: 100, recurrence: { freq: 'monthly' }, dueAt: at(24) })
// what marking done wrote: the paid default (withPaidDefault), and the next one due
const fundPaid = task('fund', { ...fund, status: 'done', completedAt: at(10, 9), actualCost: 100, recurrence: undefined })
const paidRent = withPaidDefault(task('rent-aug', { bill: { kind: 'bill' }, estimateCost: 1200, status: 'done', completedAt: at(3, 9) }))
const received = withPaidDefault(task('pay-aug', { bill: { kind: 'income' }, estimateCost: 2000, status: 'done', completedAt: at(4, 9) }))
const setAside = withPaidDefault(task('fund-aug', { bill: { kind: 'saving' }, estimateCost: 100, status: 'done', completedAt: at(5, 9) }))

describe('a set-aside is money kept', () => {
  it('is neither a bill nor a payday, and is still money', () => {
    const rows = [rent, pay, fund]
    expect(rows.filter(isBill).map(t => t.id)).toEqual(['rent'])
    expect(rows.filter(isPayday).map(t => t.id)).toEqual(['pay'])
    expect(rows.filter(isSaving).map(t => t.id)).toEqual(['fund'])
    expect(rows.filter(isMoney).map(t => t.id)).toEqual(['rent', 'pay', 'fund'])
    // what it cost is not money spent; a plain task's cost, and a bill's, is
    expect([rent, pay, fund, task('tyres', { actualCost: 400 })].map(isSpending)).toEqual([true, false, false, true])
  })

  it('is no cost and no income, and is what comes out of the month left over', () => {
    const rows = [rent, pay, fund]
    expect(monthlyCost(rows)).toBe(1200)
    expect(monthlyIncome(rows)).toBe(2000)
    expect(monthlySpare(rows)).toBe(800)
    expect(monthlySetAside(rows)).toBe(100)
  })

  it('stays out of the month of bills', () => {
    const month = billMonth([rent, fund, setAside], NOW, NOW)
    expect(month.upcoming.map(t => t.id)).toEqual(['rent'])
    expect(month.stillToPay).toBe(1200)
    expect(month.paid).toEqual([])
  })

  it('goes out of the runway on its day, marked as a set-aside', () => {
    const accounts: Account[] = [withBalance({ kind: 'account', id: 'chk', name: 'Checking', type: 'checking', balances: [], createdAt: STAMP, updatedAt: STAMP }, 2000, '2026-09-21')]
    const run = cashRunway(accounts, [rent, pay, fund], 30, NOW)
    expect(run.map(d => [d.day, d.balance])).toEqual([
      ['2026-09-24', 1900],
      ['2026-09-25', 700],
      ['2026-09-26', 2700],
    ])
    expect(run[0].rows).toEqual([expect.objectContaining({ title: 'Emergency fund', amount: 100, income: false, saving: true })])
    expect(run[0].rows[0].projected).toBeUndefined()
  })

  it('is left out of what the Stats lens says was paid, and so is a payday', () => {
    const report = moneyReport([paidRent, received, setAside, task('tyres', { status: 'done', completedAt: at(6, 9), actualCost: 400 })], 2026, NOW)
    // the rent and the tyres: a wage received and money moved to savings are not payments
    expect(report.spent).toBe(1600)
    expect(report.byPayee.map(r => r.name).sort()).toEqual(['rent-aug', 'tyres'])
    expect(report.byKind.map(r => r.key)).toEqual(['bill'])
    // nor still to pay: an open set-aside is not a bill owed
    expect(moneyReport([rent, fund], 2026, NOW).dueNow).toBe(1)
  })

  it("is left out of the week's Spend in Review, and so is a payday", () => {
    const review = buildReview(weekRange(NOW), [task('late-rent', { ...paidRent, completedAt: at(21, 9) }), task('wage', { ...received, completedAt: at(21, 9) }), task('kept', { ...setAside, completedAt: at(21, 9) })], [], [], NOW)
    expect(review.done).toHaveLength(3)
    expect(review.costs).toEqual({ estimate: 1200, actual: 1200 })
  })

  it('reads to the assistant as saving, not spending, with the goal it is for', () => {
    const src: AskSources = { tasks: [rent, pay, fund, fundPaid], projects: [], people: [], places: [], recipes: [], meals: [], entries: [], feedEvents: [], journal: [] }
    const facts = factsFor(parseQuestion('How much do we put in savings?', src, NOW), src, NOW, 'America/Phoenix')
    expect(facts).toContain('Repeating bills come to about $1,200.00 a month.')
    expect(facts).toContain('Paydays bring in about $2,000.00 a month.')
    expect(facts).toContain('About $100.00 a month is set aside into savings; that is saving, not spending.')
    expect(facts).toContain('Saving towards Emergency fund: $100.00 of $1,000.00 so far.')
  })
})

describe('a savings goal is its set-asides', () => {
  it('has saved what the finished occurrences of its series paid in', () => {
    const open = task('goal~monthly~2026-10-24', { ...fund, id: 'goal~monthly~2026-10-24', dueAt: at(24) })
    const rows = [
      open,
      // the series' first two, marked done: one with nothing typed under Paid, one with less
      task('goal', { ...fund, id: 'goal', status: 'done', completedAt: at(1, 9), recurrence: undefined }),
      task('goal~monthly~2026-09-24', { ...fund, id: 'goal~monthly~2026-09-24', status: 'done', completedAt: at(20, 9), actualCost: 80, recurrence: undefined }),
      // another series, a deleted one, and one still open do not count
      task('other', { ...fund, id: 'other', status: 'done', completedAt: at(2, 9) }),
      task('goal~monthly~2026-08-24', { ...fund, id: 'goal~monthly~2026-08-24', status: 'done', completedAt: at(2, 9), deletedAt: at(3) }),
    ]
    expect(savedSoFar(rows, open)).toEqual({ saved: 180, count: 2 })
  })

  it('carries the goal and the emoji to the next occurrence', () => {
    const next = nextOccurrence({ ...fund, status: 'done', completedAt: at(24, 9) }, () => 'x')!
    expect(next.bill).toMatchObject({ kind: 'saving', emoji: '🛟', goal: { target: 1000 } })
    expect(next.estimateCost).toBe(100)
    expect(next.dueAt?.slice(0, 10)).toBe(new Date(2026, 9, 24).toISOString().slice(0, 10))
  })
})

describe('the sanitizer keeps what a set-aside and a template wrote', () => {
  const round = (bill: unknown) => sanitizeTask({ kind: 'task', id: 't', title: 'x', status: 'todo', bill, updatedAt: STAMP })?.bill

  it('keeps a set-aside, its goal and its emoji through a sync', () => {
    expect(round({ kind: 'saving', emoji: ' 🛟 ', goal: { target: '5,000', by: '2026-12-31' } })).toMatchObject({ kind: 'saving', emoji: '🛟', goal: { target: 5000, by: '2026-12-31' } })
    expect(round({ kind: 'saving', goal: { target: 750.456 } })?.goal).toEqual({ target: 750.46 })
    // a bill's own emoji survives too
    expect(round({ kind: 'bill', emoji: '⚡' })).toMatchObject({ kind: 'bill', emoji: '⚡' })
  })

  it('drops a goal that is not one, and a goal on anything but a set-aside', () => {
    expect(round({ kind: 'saving', goal: { target: 0 } })?.goal).toBeUndefined()
    expect(round({ kind: 'saving', goal: { target: -5 } })?.goal).toBeUndefined()
    expect(round({ kind: 'saving', goal: 'lots' })?.goal).toBeUndefined()
    expect(round({ kind: 'saving', goal: { target: 100, by: '2026-12-31T08:00:00Z' } })?.goal).toEqual({ target: 100 })
    expect(round({ kind: 'bill', goal: { target: 100 } })?.goal).toBeUndefined()
  })

  it('reads the emoji a row shows from the bill, or from its kind', () => {
    expect(billEmoji({ kind: 'bill', emoji: '⚡' })).toBe('⚡')
    expect(billEmoji({ kind: 'saving' })).toBe('🐷')
    expect(billEmoji(undefined)).toBe('🧾')
  })
})
