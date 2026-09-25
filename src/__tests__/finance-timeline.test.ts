import { describe, expect, it } from 'vitest'
import { BILL_TEMPLATES, TEMPLATE_GROUPS, billFromTemplate, goalFromForm } from '../billtemplates'
import { savedSoFar } from '../bills'
import {
  CHECK_IN_DEFAULT,
  TIMELINE_DAYS,
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
  safeLine,
  safeToSpend,
  savingGoals,
  slotOf,
  withBalance,
} from '../finance'
import { dayLabel, shortDay } from '../components/finance/labels'
import { sanitizeTask } from '../schema'
import { CHECK_IN_PREFIX } from '../../shared/domain.mts'
import { BILL_KINDS, RECURRENCE_META, type Account, type Task } from '../types'

// The timeline's arithmetic: safe to spend, the cash line and its low point,
// Coming up's order, and how a savings goal is doing. All of it is read off
// one forecast (moneyForecast, the one rule: finance-rule.test.ts), so a
// figure on the screen and the same figure elsewhere cannot disagree.

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
/** A bill that does not come round again. */
const once = (id: string, amount: number, due: string) => bill(id, amount, due, { recurrence: undefined })
const account = (id: string, type: Account['type'], balances: [string, number][] = []): Account =>
  balances.reduce<Account>((a, [on, amount]) => withBalance(a, amount, on), { kind: 'account', id, name: id, type, balances: [], createdAt: STAMP, updatedAt: STAMP })

const checking = account('chk', 'checking', [['2026-09-20', 2000]])

describe('safe to spend', () => {
  // checked in on Sunday the 20th; it is Monday the 21st
  const rows = [
    bill('phone', 60, day(9, 10)), // due before the check-in: the balance has it
    bill('rent', 1200, day(9, 25)),
    setAside('fund', 100, day(9, 24)),
    payday('pay', 1840, day(10, 2)),
    bill('electric', 150, day(10, 2)), // due ON payday: the two net on the day
    bill('internet', 80, day(10, 5)),
  ]
  const say = { day: dayLabel, short: shortDay, payday: (r: { task: Task }) => r.task.title }

  it('is the lowest the line goes in the next 30 days, and says the day and what it counted', () => {
    const s = safeToSpend([checking], rows, NOW)
    // 2,000 less the fund and the rent; the phone is in the balance, and payday comes after
    expect(s.amount).toBe(2000 - 100 - 1200)
    expect(s.low).toBe('2026-09-25')
    expect(s.before?.task.id).toBe('pay')
    expect(s.through).toBe('2026-10-21')
    // next month's phone comes round on the 10th, and the pay again on the 16th
    expect([s.bills, s.paydays, s.setAsides]).toEqual([4, 2, 1])
    expect(safeLine(s, '2026-09-21', say)).toBe('Lowest on Fri, Sep 25, before pay · counts 4 bills, 2 paydays and 1 set-aside through Oct 21')
  })

  it('adds a payday due today, or late since the check-in, as it takes off a bill', () => {
    const today = payday('today', 1840, day(9, 21))
    const late = payday('late', 900, day(9, 18)) // before the check-in: in the balance already
    const s = safeToSpend([checking], [...rows, today, late], NOW)
    // today's is here now, so the fund and the rent come out of more than there was
    expect(s.amount).toBe(2000 + 1840 - 100 - 1200)
    expect(s.low).toBe('2026-09-25')
    // and both come round again: today's on the 5th and 19th, the late one's on the 2nd and 16th
    expect(s.paydays).toBe(2 + 3 + 2)
  })

  it('looks 30 days ahead, and names no payday when none comes after the low point', () => {
    const far = payday('far', 1840, day(11, 20))
    expect(TIMELINE_DAYS).toBe(30)
    const s = safeToSpend([checking], [once('rent', 1200, day(9, 25)), once('insurance', 300, day(10, 21)), once('later', 999, day(10, 22)), far], NOW)
    expect(s.before).toBeNull()
    expect(s.through).toBe('2026-10-21')
    expect(s.amount).toBe(2000 - 1200 - 300)
    expect(safeLine(s, '2026-09-21', say)).toBe('Lowest on Wed, Oct 21 · counts 2 bills through Oct 21')
  })

  it('counts checking and cash, never savings, from the newest check-in on them', () => {
    const accounts = [checking, account('sav', 'savings', [['2026-09-16', 500]]), account('tin', 'cash', [['2026-09-19', 40]]), account('new', 'checking')]
    const s = safeToSpend(accounts, [], NOW)
    // savings is kept, not spent (the owner's rule): 2000 + 40, not + 500
    expect(s.amount).toBe(2040)
    expect(s.spendable).toBe(2040)
    // checking's, the day before the tin's: a day apart is not stale
    expect(s.asOf).toBe('2026-09-20')
    expect(s.stale).toEqual([])
    expect(s.unchecked).toBe(1)
    expect(safeLine(s, '2026-09-21', say)).toBe('Nothing falls due through Oct 21')
    // the accounts total still has the savings in it
    expect(moneyTotals(accounts).liquid).toBe(2540)
    expect(s.asOf).toBe(moneyTotals(accounts).spendableAsOf)
  })

  it('has no figure from a savings balance alone', () => {
    expect(safeToSpend([account('sav', 'savings', [['2026-09-20', 5000]])], [], NOW).amount).toBeNull()
    expect(cashLine([account('sav', 'savings', [['2026-09-20', 5000]])], [], 30, NOW)).toBeNull()
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
    // the 16th has both paydays: pay2's own, and pay's again a fortnight on
    expect(line.days.map(d => d.balance)).toEqual([800, 1800, -300, 1700])
    expect(line.low).toEqual({ day: '2026-10-03', balance: -300 })
    expect(line.high).toBe(2000)
    // the shortfall in firstShortfall's own words
    expect(line.short).toEqual(firstShortfall(cashRunway([checking], rows, 30, NOW)))
    // and safe to spend is its low point
    expect(safeToSpend([checking], rows, NOW).amount).toBe(line.low.balance)
  })

  it('finds a lower point once it looks 60 days ahead, with every repeat that lands in it', () => {
    const line = cashLine([checking], rows, 60, NOW)!
    // the rent again on the 25th, the car again on the 3rd, then the insurance
    expect(line.low).toEqual({ day: '2026-11-05', balance: -1100 })
    expect(line.days.map(d => d.day)).toEqual(['2026-09-25', '2026-10-02', '2026-10-03', '2026-10-16', '2026-10-25', '2026-10-30', '2026-11-03', '2026-11-05', '2026-11-13'])
  })

  it('lies flat at today when nothing takes it lower, and is not drawn with no balance', () => {
    expect(cashLine([checking], [payday('pay', 1000, day(10, 2))], 30, NOW)!.low).toEqual({ day: '2026-09-21', balance: 2000 })
    expect(cashLine([], rows, 30, NOW)).toBeNull()
  })
})

describe('coming up', () => {
  it('puts what is overdue first, then goes by day, money in before money out, what repeats with it', () => {
    const { rows, undated } = comingUp(
      [],
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
    expect(rows.map(r => r.task.id)).toEqual(['late', 'later', 'fund', 'water', 'pay', 'rent', 'pay', 'late', 'later'])
    expect(rows.map(r => r.overdue)).toEqual([true, true, false, false, false, false, false, false, false])
    // what the repeats bring is expected, not a task yet: the pay a fortnight on, the late bills next month
    expect(rows.slice(6).map(r => [r.task.id, r.due, r.projected])).toEqual([
      ['pay', '2026-10-09', true],
      ['late', '2026-10-12', true],
      ['later', '2026-10-15', true],
    ])
    // an overdue one is owed today, and remembers when it was due
    expect(rows[0]).toMatchObject({ day: '2026-09-21', due: '2026-09-12' })
    expect(rows.find(r => r.task.id === 'water')?.amount).toBeUndefined()
    expect(rows.find(r => r.task.id === 'fund')).toMatchObject({ saving: true, income: false })
    expect(undated).toEqual([])
  })
})

describe('what is overdue, by the one rule', () => {
  it('is a day that is over: a bill due today stays today’s, its time gone by or not (shared/due.mts)', () => {
    const morning = bill('morning', 20, new Date(2026, 8, 21, 9, 0).toISOString())
    const yesterday = bill('yesterday', 20, new Date(2026, 8, 20, 23, 0).toISOString())
    const rows = comingUp([], [morning, yesterday], NOW).rows.filter(r => !r.projected)
    expect(rows.map(r => [r.task.id, r.overdue, r.day])).toEqual([
      ['yesterday', true, '2026-09-21'],
      ['morning', false, '2026-09-21'],
    ])
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
