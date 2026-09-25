import { describe, expect, it } from 'vitest'
import { billMonth, isBill, isPayday, monthlyCost, monthlyIncome, monthlySpare } from '../bills'
import { balanceOn, cashRunway, firstShortfall, latestBalance, moneyTotals, withBalance } from '../finance'
import { sanitizeAccount, sanitizeItem, sanitizeTask } from '../schema'
import type { Account, Task } from '../types'

// Bills said what was due this month. It could not say whether there would be
// enough in the account before the 3rd, because nothing here knew what came IN
// or what the accounts held. A payday is a bill with the sign the other way
// round; an account is a name and the balances you have typed in. Drafter
// never connects to a bank, so every figure below is arithmetic over exactly
// what was written down.

const NOW = new Date('2026-09-21T12:00:00.000Z')
const money = (over: Partial<Task> & { id: string }): Task =>
  ({
    kind: 'task',
    title: over.id,
    description: '',
    status: 'todo',
    priority: 'normal',
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }) as Task

const wage = (id: string, amount: number, freq: 'weekly' | 'biweekly' | 'monthly', dueAt?: string) =>
  money({ id, bill: { kind: 'income' }, estimateCost: amount, recurrence: { freq }, dueAt })
const outgoing = (id: string, amount: number, dueAt?: string) =>
  money({ id, bill: { kind: 'bill' }, estimateCost: amount, recurrence: { freq: 'monthly' }, dueAt })

const account = (over: Partial<Account> & { id: string }): Account =>
  ({ kind: 'account', name: over.id, type: 'checking', balances: [], createdAt: '', updatedAt: '', ...over }) as Account

describe('a payday is a bill with the sign the other way round', () => {
  it('is never counted as a cost, and a cost is never counted as income', () => {
    const rows = [wage('pay', 1840, 'biweekly'), outgoing('rent', 1200)]
    expect(rows.filter(isBill).map(t => t.id)).toEqual(['rent'])
    expect(rows.filter(isPayday).map(t => t.id)).toEqual(['pay'])
    expect(monthlyCost(rows)).toBe(1200)
    // 26 a year is 2.17 a month, not 2: the three-payday months are already in it
    expect(monthlyIncome(rows)).toBeCloseTo(1840 * (26 / 12), 2)
    expect(monthlySpare(rows)).toBeCloseTo(monthlyIncome(rows) - 1200, 2)
  })

  it('stays out of the month of bills, which is about what is owed', () => {
    const month = billMonth([wage('pay', 1840, 'biweekly', '2026-09-25T09:00:00.000Z'), outgoing('rent', 1200, '2026-09-25T09:00:00.000Z')], NOW, NOW)
    expect(month.upcoming.map(t => t.id)).toEqual(['rent'])
    expect(month.stillToPay).toBe(1200)
  })

  it('keeps whose payday it is through a save', () => {
    const saved = sanitizeTask({
      kind: 'task',
      id: 't',
      title: 'Payday',
      status: 'todo',
      bill: { kind: 'income', forMemberId: '11111111-1111-1111-1111-111111111111', payee: 'Acme' },
      updatedAt: NOW.toISOString(),
    })
    expect(saved?.bill).toMatchObject({ kind: 'income', forMemberId: '11111111-1111-1111-1111-111111111111', payee: 'Acme' })
  })
})

describe('an account is the balances you typed in', () => {
  it('keeps one per day, so correcting today replaces today', () => {
    let a = account({ id: 'chk' })
    a = withBalance(a, 500, '2026-09-20')
    a = withBalance(a, 400, '2026-09-21')
    a = withBalance(a, 420, '2026-09-21')
    expect(a.balances).toEqual([
      { on: '2026-09-20', amount: 500 },
      { on: '2026-09-21', amount: 420 },
    ])
    expect(latestBalance(a)).toEqual({ on: '2026-09-21', amount: 420 })
  })

  it('answers what it held on a day, or the newest before it', () => {
    const a = withBalance(withBalance(account({ id: 'chk' }), 500, '2026-09-01'), 300, '2026-09-15')
    expect(balanceOn(a, '2026-09-10')).toEqual({ on: '2026-09-01', amount: 500 })
    expect(balanceOn(a, '2026-09-20')).toEqual({ on: '2026-09-15', amount: 300 })
    expect(balanceOn(a, '2026-08-31')).toBeNull()
  })

  it('sorts and de-duplicates whatever a device wrote', () => {
    const a = sanitizeAccount({
      id: 'chk',
      name: 'Checking',
      type: 'savings',
      balances: [
        { on: '2026-09-21', amount: 1 },
        { on: '2026-09-01', amount: 2 },
        { on: '2026-09-21', amount: 3 },
        { on: 'nonsense', amount: 4 },
      ],
      updatedAt: NOW.toISOString(),
    })
    expect(a?.balances).toEqual([
      { on: '2026-09-01', amount: 2 },
      { on: '2026-09-21', amount: 3 },
    ])
    expect(a?.type).toBe('savings')
    // an unknown type falls back rather than being kept as a type nothing can draw
    expect(sanitizeAccount({ id: 'x', name: 'X', type: 'crypto', updatedAt: NOW.toISOString() })?.type).toBe('checking')
    expect(sanitizeItem({ kind: 'account', id: 'y', name: 'Y', updatedAt: NOW.toISOString() })).toMatchObject({ kind: 'account' })
  })
})

describe('what the household has', () => {
  const accounts = [
    withBalance(account({ id: 'chk', type: 'checking' }), 2000, '2026-09-20'),
    withBalance(account({ id: 'sav', type: 'savings' }), 5000, '2026-03-01'),
    withBalance(account({ id: 'visa', type: 'credit' }), 1200, '2026-09-20'),
    withBalance(account({ id: 'brk', type: 'investment' }), 9000, '2026-09-20'),
    account({ id: 'unchecked' }),
  ]

  it('counts a card as owed, and keeps an investment out of what you could spend', () => {
    const t = moneyTotals(accounts)
    expect(t.net).toBe(2000 + 5000 + 9000 - 1200)
    expect(t.liquid).toBe(7000)
    expect(t.owed).toBe(1200)
    expect(t.unknown).toBe(1)
  })

  it('is only as fresh as its OLDEST check-in, and says so', () => {
    // one balance typed this morning and one from March is a March picture
    expect(moneyTotals(accounts).asOf).toBe('2026-03-01')
  })

  it('keeps savings out of what is meant for spending, and in the rest', () => {
    // the owner's rule: savings is kept, not spent — checking and cash only
    const t = moneyTotals(accounts)
    expect(t.spendable).toBe(2000)
    expect(t.liquid).toBe(7000)
    // and the spendable figure is as fresh as checking, not March's savings
    expect(t.spendableAsOf).toBe('2026-09-20')
    expect(moneyTotals([withBalance(account({ id: 'tin', type: 'cash' }), 60, '2026-09-18'), ...accounts]).spendable).toBe(2060)
  })

  it('leaves a closed account out without deleting it', () => {
    const closed = [...accounts, withBalance(account({ id: 'old', archivedAt: '2026-01-01T00:00:00.000Z' }), 999, '2026-09-20')]
    expect(moneyTotals(closed).liquid).toBe(7000)
  })
})

describe('the runway counts what is written down, every time it lands', () => {
  const accounts = [withBalance(account({ id: 'chk' }), 900, '2026-09-20')]

  it('walks the money down day by day and names the day it runs out', () => {
    const rows = cashRunway(accounts, [outgoing('rent', 1200, '2026-09-25T09:00:00.000Z'), wage('pay', 1840, 'biweekly', '2026-09-30T09:00:00.000Z')], 60, NOW)
    // the wage every fortnight and the rent every month, as far as it looks
    expect(rows.map(r => r.day)).toEqual(['2026-09-25', '2026-09-30', '2026-10-14', '2026-10-25', '2026-10-28', '2026-11-11'])
    expect(rows[0].balance).toBe(-300)
    expect(rows[1].balance).toBe(1540)
    expect(rows.at(-1)?.balance).toBe(5860)
    expect(firstShortfall(rows)).toEqual({ day: '2026-09-25', balance: -300 })
  })

  it('owes an overdue bill today when it fell due since the check-in, and leaves one due before it in the balance', () => {
    const late = outgoing('late', 100, '2026-09-01T09:00:00.000Z')
    const rows = cashRunway([withBalance(account({ id: 'chk' }), 900, '2026-08-31')], [late], 60, NOW)
    expect(rows[0].day).toBe('2026-09-21')
    expect(rows[0].balance).toBe(800)
    // checked in after it fell due: the balance has it, and next month's is what comes off
    expect(cashRunway(accounts, [late], 60, NOW).map(r => [r.day, r.balance])).toEqual([
      ['2026-10-01', 800],
      ['2026-11-01', 700],
    ])
  })

  it('counts one already done when it is dated after the check-in, and nothing past the window', () => {
    const done = money({ id: 'paid', bill: { kind: 'bill' }, estimateCost: 50, status: 'done', dueAt: '2026-09-25T09:00:00.000Z' })
    const far = outgoing('later', 50, '2027-09-25T09:00:00.000Z')
    // ticked off early, and the balance typed in before it went: it comes off on its own day
    expect(cashRunway(accounts, [done, far], 60, NOW).map(r => [r.day, r.balance])).toEqual([['2026-09-25', 850]])
    // dated before the check-in, the balance already has it
    expect(cashRunway(accounts, [{ ...done, dueAt: '2026-09-19T09:00:00.000Z' }, far], 60, NOW)).toEqual([])
    expect(firstShortfall([])).toBeNull()
  })
})
