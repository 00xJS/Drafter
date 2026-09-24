import { describe, expect, it } from 'vitest'
import { BILL_TEMPLATES, TEMPLATE_GROUPS, billFromTemplate, goalFromForm } from '../billtemplates'
import { savedSoFar } from '../bills'
import {
  CHECK_IN_DEFAULT,
  PAYDAY_HORIZON_DAYS,
  afterLine,
  cashLine,
  cashRunway,
  checkInDone,
  checkInTask,
  comingUp,
  daysBetween,
  firstShortfall,
  moneyTotals,
  nextSlot,
  occurrencesUntil,
  openCheckIn,
  parseBalance,
  safeToSpend,
  savingGoals,
  slotOf,
  withBalance,
} from '../finance'
import { sanitizeTask } from '../schema'
import { CHECK_IN_PREFIX } from '../../shared/domain.mts'
import { BILL_KINDS, RECURRENCE_META, type Account, type Task } from '../types'

// The timeline's arithmetic: safe to spend until payday, the cash line and its
// low point, Coming up's order, and how a savings goal is doing. All of it is
// read from the same rows the runway always counted, so a figure on the new
// screen and the same figure elsewhere cannot disagree.

/** Monday 21 September 2026, noon: the day a view hands in (noonOf). */
const NOW = new Date(2026, 8, 21, 12, 0)
const STAMP = '2026-09-01T00:00:00.000Z'
const day = (m: number, d: number) => new Date(2026, m - 1, d).toISOString()
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
const bill = (id: string, amount: number | undefined, due: string, over: Partial<Task> = {}) =>
  task(id, { bill: { kind: 'bill' }, estimateCost: amount, recurrence: { freq: 'monthly' }, dueAt: due, ...over })
const payday = (id: string, amount: number, due: string, over: Partial<Task> = {}) =>
  task(id, { bill: { kind: 'income' }, estimateCost: amount, recurrence: { freq: 'biweekly' }, dueAt: due, ...over })
const setAside = (id: string, amount: number, due: string, over: Partial<Task> = {}) =>
  task(id, { bill: { kind: 'saving' }, estimateCost: amount, recurrence: { freq: 'monthly' }, dueAt: due, ...over })
const account = (id: string, type: Account['type'], balances: [string, number][] = []): Account =>
  balances.reduce<Account>((a, [on, amount]) => withBalance(a, amount, on), { kind: 'account', id, name: id, type, balances: [], createdAt: STAMP, updatedAt: STAMP })

const checking = account('chk', 'checking', [['2026-09-20', 2000]])

describe('safe to spend until payday', () => {
  const rows = [
    bill('phone', 60, day(9, 10)), // overdue: owed now
    bill('rent', 1200, day(9, 25)),
    setAside('fund', 100, day(9, 24)),
    payday('pay', 1840, day(10, 2)),
    bill('electric', 150, day(10, 2)), // due ON payday: that payday's
    bill('internet', 80, day(10, 5)), // after it
  ]

  it('is what the accounts hold less every bill and set-aside before the next payday', () => {
    const s = safeToSpend([checking], rows, NOW)
    expect(s.amount).toBe(2000 - 60 - 1200 - 100)
    expect(s.payday?.task.id).toBe('pay')
    expect(s.through).toBe('2026-10-01')
    expect([s.bills, s.setAsides, s.owed]).toEqual([2, 1, 1360])
    expect(afterLine(s)).toBe('after 2 bills and a set-aside')
  })

  it('runs to the payday after today: one due today, or late, is in the balance or not here yet', () => {
    const today = payday('today', 1840, day(9, 21))
    const late = payday('late', 900, day(9, 18))
    const s = safeToSpend([checking], [...rows, today, late], NOW)
    expect(s.payday?.task.id).toBe('pay')
    // and neither is added to what is there
    expect(s.amount).toBe(640)
  })

  it('covers the next 30 days when no payday lands within 45', () => {
    const far = payday('far', 1840, day(11, 20))
    expect(PAYDAY_HORIZON_DAYS).toBe(45)
    const s = safeToSpend([checking], [bill('rent', 1200, day(9, 25)), bill('insurance', 300, day(10, 21)), bill('later', 999, day(10, 22)), far], NOW)
    expect(s.payday).toBeNull()
    expect(s.through).toBe('2026-10-21')
    expect(s.amount).toBe(2000 - 1200 - 300)
    expect(afterLine(s)).toBe('after 2 bills')
  })

  it('is as old as the oldest check-in, and leaves out an account with none', () => {
    const accounts = [checking, account('sav', 'savings', [['2026-09-16', 500]]), account('new', 'checking')]
    const s = safeToSpend(accounts, [], NOW)
    expect(s.amount).toBe(2500)
    expect(s.asOf).toBe('2026-09-16')
    expect(s.unchecked).toBe(1)
    expect(afterLine(s)).toBe('nothing due before then')
    // the same "as of" the totals have always said (moneyTotals)
    expect(s.asOf).toBe(moneyTotals(accounts).asOf)
  })

  it('has no figure until an account you can spend from has a balance', () => {
    expect(safeToSpend([], rows, NOW).amount).toBeNull()
    expect(safeToSpend([account('empty', 'checking')], rows, NOW).amount).toBeNull()
    // a card's balance is what is owed, not money to spend
    expect(safeToSpend([account('visa', 'credit', [['2026-09-20', 400]])], rows, NOW).amount).toBeNull()
  })

  it('counts a bill with no amount as nothing, and says it is there', () => {
    const s = safeToSpend([checking], [bill('water', undefined, day(9, 23)), payday('pay', 1840, day(10, 2))], NOW)
    expect(s.amount).toBe(2000)
    expect(s.unpriced).toBe(1)
  })
})

describe('the cash line', () => {
  const rows = [
    bill('rent', 1200, day(9, 25)),
    payday('pay', 1000, day(10, 2)),
    bill('car', 2100, day(10, 3)),
    payday('pay2', 1000, day(10, 16)),
    bill('insurance', 1500, day(11, 5)), // 45 days out: only a 60-day line sees it
  ]

  it('starts at what is there now and marks its low point in the next 30 days', () => {
    const line = cashLine([checking], rows, 30, NOW)!
    expect(line.start).toBe(2000)
    expect(line.from).toBe('2026-09-21')
    expect(line.to).toBe('2026-10-21')
    expect(line.days.map(d => d.balance)).toEqual([800, 1800, -300, 700])
    expect(line.low).toEqual({ day: '2026-10-03', balance: -300 })
    expect(line.high).toBe(2000)
    // the shortfall in firstShortfall's own words
    expect(line.short).toEqual(firstShortfall(cashRunway([checking], rows, 30, NOW)))
  })

  it('finds a lower point once it looks 60 days ahead', () => {
    const line = cashLine([checking], rows, 60, NOW)!
    expect(line.low).toEqual({ day: '2026-11-05', balance: -800 })
  })

  it('lies flat at today when nothing takes it lower, and is not drawn with no balance', () => {
    expect(cashLine([checking], [payday('pay', 1000, day(10, 2))], 30, NOW)!.low).toEqual({ day: '2026-09-21', balance: 2000 })
    expect(cashLine([], rows, 30, NOW)).toBeNull()
  })
})

describe('coming up', () => {
  it('puts what is overdue first, then goes by day, money in before money out', () => {
    const rows = comingUp(
      [
        bill('rent', 1200, day(9, 25)),
        payday('pay', 1840, day(9, 25)),
        bill('late', 50, day(9, 12)),
        bill('later', 40, day(9, 15)),
        setAside('fund', 100, day(9, 22)),
        bill('water', undefined, day(9, 23)),
        bill('far', 10, day(10, 22)), // 31 days out
        bill('wish', 10, day(9, 24), { status: 'wishlist' }),
        bill('off', 10, day(9, 24), { status: 'canceled' }),
        bill('paid', 10, day(9, 24), { status: 'done', completedAt: day(9, 20) }),
        task('chore', { dueAt: day(9, 22) }),
      ],
      NOW,
    )
    expect(rows.map(r => r.task.id)).toEqual(['late', 'later', 'fund', 'water', 'pay', 'rent'])
    expect(rows.map(r => r.overdue)).toEqual([true, true, false, false, false, false])
    // an overdue one is owed today, and remembers when it was due
    expect(rows[0]).toMatchObject({ day: '2026-09-21', due: '2026-09-12' })
    expect(rows.find(r => r.task.id === 'water')?.amount).toBeUndefined()
    expect(rows.find(r => r.task.id === 'fund')).toMatchObject({ saving: true, income: false })
  })
})

describe('a savings goal', () => {
  const goal = (over: Partial<Task> = {}, target = 1000, by?: string) =>
    task('goal', { title: 'Trip', bill: { kind: 'saving', goal: { target, ...(by ? { by } : {}) } }, estimateCost: 100, recurrence: { freq: 'monthly' }, dueAt: day(10, 1), ...over })
  const done = (id: string, paid: number) => task(id, { bill: { kind: 'saving' }, estimateCost: 100, actualCost: paid, status: 'done', completedAt: day(9, 1) })

  it('counts the set-asides still to come up to its date, the next one included', () => {
    expect(occurrencesUntil(goal(), '2026-12-31')).toBe(3)
    expect(occurrencesUntil(goal(), '2026-12-01')).toBe(3)
    expect(occurrencesUntil(goal(), '2026-11-30')).toBe(2)
    expect(occurrencesUntil(goal(), '2026-09-30')).toBe(0)
    // a month-end series lands where the real ones will (28 Feb, then 31 Mar)
    const monthEnd = goal({ dueAt: day(1, 31) })
    expect(occurrencesUntil(monthEnd, '2026-03-31')).toBe(3)
    expect(occurrencesUntil(monthEnd, '2026-03-30')).toBe(2)
  })

  it('is on track when what is saved and still to come reaches the target by its date', () => {
    const open = goal({ id: 'goal~monthly~2026-10-01' }, 1000, '2027-02-01')
    const [g] = savingGoals([open, done('goal', 100), done('goal~monthly~2026-09-01', 100)], NOW)
    expect(g).toMatchObject({ saved: 200, count: 2, each: 100, left: 5, projected: 700, status: 'behind', needed: 160, pct: 20, toGo: 8 })
    const [ok] = savingGoals([{ ...open, estimateCost: 160 }, done('goal', 100), done('goal~monthly~2026-09-01', 100)], NOW)
    expect(ok).toMatchObject({ projected: 1000, status: 'on-track' })
  })

  it('has reached it once the set-asides add up, whatever the date', () => {
    const [g] = savingGoals([goal({}, 150, '2026-01-01'), done('goal', 200)], NOW)
    expect(g).toMatchObject({ status: 'reached', pct: 100 })
  })

  it('is behind once its date has gone, and simply open with none', () => {
    expect(savingGoals([goal({}, 1000, '2026-09-01')], NOW)[0]).toMatchObject({ status: 'behind', left: 0, projected: 0 })
    const open = savingGoals([goal()], NOW)[0]
    expect(open.status).toBe('open')
    expect(open.left).toBeUndefined()
  })

  it('reads its progress from savedSoFar, one card per series', () => {
    const open = goal({ id: 'goal~monthly~2026-10-01' }, 1000)
    const twin = goal({ id: 'goal~monthly~2026-10-02', dueAt: day(10, 2) }, 1000)
    const rows = [open, twin, done('goal', 100)]
    const goals = savingGoals(rows, NOW)
    expect(goals).toHaveLength(1)
    expect(goals[0].task.id).toBe('goal~monthly~2026-10-01')
    expect(goals[0].saved).toBe(savedSoFar(rows, open).saved)
  })

  it('leaves out a set-aside with no goal, and one that is finished', () => {
    expect(savingGoals([setAside('plain', 100, day(10, 1)), goal({ status: 'done', completedAt: day(9, 20) })], NOW)).toEqual([])
  })
})

describe('bill templates', () => {
  it('has the household bills, names and emoji only, each on a cadence that exists', () => {
    const names = BILL_TEMPLATES.map(t => t.name)
    for (const n of ['Rent', 'Mortgage', 'Electric', 'Water & sewer', 'Gas', 'Trash', 'HOA', 'Internet', 'Phone', 'Car insurance', 'Car payment', 'Health insurance', 'Credit card', 'Netflix', 'Hulu', 'Disney+', 'Max', 'Spotify', 'YouTube Premium', 'Apple', 'Gym', 'Childcare']) {
      expect(names).toContain(n)
    }
    expect(BILL_TEMPLATES.find(t => t.key === 'other')).toMatchObject({ name: '', kind: 'bill' })
    for (const t of BILL_TEMPLATES) {
      expect(Object.keys(RECURRENCE_META)).toContain(t.freq)
      expect(['bill', 'card', 'subscription', 'loan']).toContain(t.kind)
      expect(BILL_KINDS).toContain(t.kind)
      expect(TEMPLATE_GROUPS.map(g => g.key)).toContain(t.group)
      expect(t.emoji.length).toBeGreaterThan(0)
    }
    expect(new Set(BILL_TEMPLATES.map(t => t.key)).size).toBe(BILL_TEMPLATES.length)
  })

  it('writes a bill the sanitizer keeps as it is, due on the day with no time', () => {
    const electric = BILL_TEMPLATES.find(t => t.key === 'electric')!
    const t = billFromTemplate(electric, { name: ' Electric ', amount: 142.456, due: '2026-10-05', freq: 'monthly', autopay: true, shared: true }, { id: 'b1', now: STAMP })
    expect(t).toMatchObject({ title: 'Electric', estimateCost: 142.46, recurrence: { freq: 'monthly' }, bill: { kind: 'bill', emoji: '⚡', autopay: true }, shared: true })
    expect(new Date(t.dueAt!).getHours()).toBe(0)
    expect(t.dueAt).toBe(new Date(2026, 9, 5).toISOString())
    expect(sanitizeTask(JSON.parse(JSON.stringify(t)))).toEqual(sanitizeTask(t))
    expect(sanitizeTask(t)?.bill).toEqual(t.bill)
  })

  it('writes a goal as a repeating set-aside with the goal on it', () => {
    const t = goalFromForm({ name: 'Emergency fund', emoji: '🛟', target: 5000, by: '2027-06-30', amount: 200, freq: 'biweekly', first: '2026-10-02', autopay: false }, { id: 'g1', now: STAMP })
    expect(t).toMatchObject({ title: 'Emergency fund', estimateCost: 200, recurrence: { freq: 'biweekly' }, bill: { kind: 'saving', emoji: '🛟', goal: { target: 5000, by: '2027-06-30' } }, shared: false })
    expect(sanitizeTask(t)?.bill).toEqual(t.bill)
  })
})

describe('a typed balance', () => {
  it('reads the ways people write money', () => {
    expect(parseBalance('$1,234.56')).toBe(1234.56)
    expect(parseBalance(' 2400 ')).toBe(2400)
    expect(parseBalance('-80')).toBe(-80)
    expect(parseBalance('$-80.50')).toBe(-80.5)
    expect(parseBalance('(80)')).toBe(-80)
    expect(parseBalance('0')).toBe(0)
    expect(parseBalance('')).toBeNull()
    expect(parseBalance('lots')).toBeNull()
    expect(parseBalance('1.2.3')).toBeNull()
  })

  it('counts whole days since it was typed in', () => {
    expect(daysBetween('2026-09-21', '2026-09-21')).toBe(0)
    expect(daysBetween('2026-09-19', '2026-09-21')).toBe(2)
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3)
  })
})

describe('the weekly check-in', () => {
  it('falls on Sunday at six until it is moved', () => {
    expect(CHECK_IN_DEFAULT).toEqual({ weekday: 0, time: '18:00' })
    // from a Monday: the coming Sunday
    expect(nextSlot(NOW, 0, '18:00')).toEqual(new Date(2026, 8, 27, 18, 0))
    // on a Sunday before six: today; after: next week
    expect(nextSlot(new Date(2026, 8, 27, 17, 0), 0, '18:00')).toEqual(new Date(2026, 8, 27, 18, 0))
    expect(nextSlot(new Date(2026, 8, 27, 18, 0), 0, '18:00')).toEqual(new Date(2026, 9, 4, 18, 0))
    expect(nextSlot(NOW, 3, '07:30')).toEqual(new Date(2026, 8, 23, 7, 30))
    expect(slotOf(new Date(2026, 8, 27, 18, 0).toISOString())).toEqual({ weekday: 0, time: '18:00' })
  })

  it('is a private weekly task whose id marks it as the check-in', () => {
    const t = checkInTask(new Date(2026, 8, 27, 18, 0), { id: 'abc', now: STAMP })
    expect(t).toMatchObject({ id: `${CHECK_IN_PREFIX}abc`, title: 'Check in your balances', recurrence: { freq: 'weekly' }, shared: false, status: 'todo' })
    expect(sanitizeTask(t)).toMatchObject({ id: t.id, recurrence: { freq: 'weekly' }, shared: false })
  })

  it('is the reader’s own, open one', () => {
    const mine = checkInTask(new Date(2026, 8, 27, 18, 0), { id: 'me', now: STAMP })
    const theirs = { ...checkInTask(new Date(2026, 8, 27, 18, 0), { id: 'them', now: STAMP }), ownerId: 'maria' }
    const gone = { ...checkInTask(new Date(2026, 8, 27, 18, 0), { id: 'old', now: STAMP }), deletedAt: STAMP }
    expect(openCheckIn([theirs, gone, { ...mine, ownerId: 'joseph' }], 'joseph')?.id).toBe(mine.id)
    expect(openCheckIn([theirs], 'joseph')).toBeNull()
    // local mode: no one else
    expect(openCheckIn([mine], null)?.id).toBe(mine.id)
  })

  it('counts a check-in within two days of it as that week’s', () => {
    const sunday = checkInTask(new Date(2026, 8, 27, 18, 0), { id: 'me', now: STAMP })
    expect(checkInDone([sunday], null, new Date(2026, 8, 25, 19, 0))?.id).toBe(sunday.id)
    expect(checkInDone([sunday], null, new Date(2026, 8, 28, 9, 0))?.id).toBe(sunday.id)
    expect(checkInDone([sunday], null, new Date(2026, 8, 24, 19, 0))).toBeNull()
  })
})
