import { describe, expect, it } from 'vitest'
import { cashLine, cashRunway, comingUp, countsList, moneyForecast, safeLine, safeToSpend, seriesDays, staleSpendable, undatedLine, withBalance, type SafeToSpend } from '../finance'
import { dayLabel, moneyName, shortDay } from '../components/finance/labels'
import { RECURRENCE_FREQS, nextOccurrence, stepDue } from '../../shared/domain.mts'
import { dateKey } from '../utils'
import type { Account, BillKind, RecurrenceFreq, Task } from '../types'

// The one rule (finance.ts): the balance you checked in is the truth on its
// day. Every bill, payday and set-aside dated after it counts, money in and
// money out alike, done or not, and a repeat every time it lands; anything
// dated on or before it is already in the balance. Safe to spend is the
// lowest the line that makes goes in the next 30 days.
//
// The owner found the old arithmetic counting bills against the month and not
// a paycheck. These hold each half of the rule on its own, and then his own
// money as he entered it.

/** Thursday 24 September 2026, noon: the day a view hands in (noonOf). */
const NOW = new Date(2026, 8, 24, 12, 0)
const TODAY = '2026-09-24'
const STAMP = '2026-09-01T00:00:00.000Z'
const day = (m: number, d: number, y = 2026) => new Date(y, m - 1, d).toISOString()
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
/** Money that comes round: a bill or set-aside monthly, a payday every two weeks, unless said otherwise. */
const money = (id: string, kind: BillKind, amount: number | undefined, dueAt: string | undefined, over: Partial<Task> = {}) =>
  task(id, { bill: { kind }, estimateCost: amount, recurrence: { freq: kind === 'income' ? 'biweekly' : 'monthly' }, dueAt, ...over })
/** Money that does not come round again. */
const once = (id: string, kind: BillKind, amount: number | undefined, dueAt: string | undefined, over: Partial<Task> = {}) => money(id, kind, amount, dueAt, { recurrence: undefined, ...over })
const account = (id: string, type: Account['type'], balances: [string, number][] = []): Account =>
  balances.reduce<Account>((a, [on, amount]) => withBalance(a, amount, on), { kind: 'account', id, name: id, type, balances: [], createdAt: STAMP, updatedAt: STAMP })
const checkedIn = (on: string, amount: number) => account('chk', 'checking', [[on, amount]])
const say = (names: Record<string, string> = {}) => ({ day: dayLabel, short: shortDay, payday: (r: { task: Task }) => moneyName(r.task, names[r.task.bill?.forMemberId ?? ''] ?? null) })

describe('a repeat lands where its real occurrences will', () => {
  const series = (freq: RecurrenceFreq, dueAt: string, keep?: number): Task => task('s', { bill: { kind: 'bill', ...(keep !== undefined ? { day: keep } : {}) }, recurrence: { freq }, dueAt, estimateCost: 10 })
  const starts: [Date, number?][] = [
    [new Date(2026, 0, 31)],
    [new Date(2026, 0, 30, 9, 15)],
    [new Date(2026, 1, 28), 31],
    [new Date(2026, 2, 31, 18, 30)],
    [new Date(2026, 7, 31)],
    [new Date(2026, 9, 31)],
    [new Date(2026, 11, 31, 23, 0)],
    [new Date(2028, 1, 29)],
    [new Date(2026, 8, 26)],
  ]

  it('steps every cadence to the days nextOccurrence gives the real ones, month ends and a bill’s own day included', () => {
    for (const freq of RECURRENCE_FREQS) {
      for (const [start, keep] of starts) {
        let t = series(freq, start.toISOString(), keep)
        const real: string[] = []
        for (let i = 0; i < 30; i++) {
          const next = nextOccurrence({ ...t, status: 'done', completedAt: t.dueAt }, () => '')!
          real.push(dateKey(new Date(next.dueAt!)))
          t = next
        }
        expect(seriesDays(series(freq, start.toISOString(), keep), '2099-12-31').slice(1, 31), `${freq} from ${start.toString()}`).toEqual(real)
      }
    }
  })

  it('is one step, shared: nextOccurrence takes exactly the step stepDue gives, and keeps the day it returns', () => {
    for (const freq of RECURRENCE_FREQS) {
      for (const [start, keep] of starts) {
        const t = series(freq, start.toISOString(), keep)
        const next = nextOccurrence(t, () => '')!
        const step = stepDue(new Date(t.dueAt!), freq, keep)
        expect(next.dueAt, freq).toBe(step.at.toISOString())
        expect(next.bill?.day, freq).toBe(step.day)
      }
    }
  })

  it('clamps a monthly bill on the 31st as the real ones do, and goes back to the 31st after', () => {
    const rent = money('rent', 'bill', 900, day(10, 31))
    const f = moneyForecast([checkedIn(TODAY, 5000)], [rent], 180, NOW)
    expect(f.rows.map(r => r.due)).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28'])
    expect(f.rows.map(r => r.projected)).toEqual([false, true, true, true, true])
  })

  it('lands a fortnightly paycheck three times in 30 days from two days out', () => {
    const pay = money('pay', 'income', 2000, day(9, 26))
    const rows = comingUp([checkedIn(TODAY, 100)], [pay], NOW).rows
    expect(rows.map(r => [r.due, r.projected])).toEqual([
      ['2026-09-26', false],
      ['2026-10-10', true],
      ['2026-10-24', true],
    ])
    expect(safeToSpend([checkedIn(TODAY, 100)], [pay], NOW).paydays).toBe(3)
    expect(cashRunway([checkedIn(TODAY, 100)], [pay], 30, NOW).map(d => d.balance)).toEqual([2100, 4100, 6100])
  })

  it('counts a monthly bill twice in 60 days, as the 60 days under Accounts show it', () => {
    const run = cashRunway([checkedIn(TODAY, 3000)], [money('rent', 'bill', 1000, day(10, 1))], 60, NOW)
    expect(run.map(d => [d.day, d.balance])).toEqual([
      ['2026-10-01', 2000],
      ['2026-11-01', 1000],
    ])
  })
})

describe('the balance you checked in is the truth on its day', () => {
  // checked in on Monday the 21st; it is Thursday the 24th
  const chk = checkedIn('2026-09-21', 1000)

  it('leaves out what is dated on or before it, and counts what is dated since on today', () => {
    const rows = [
      once('before', 'bill', 300, day(9, 20)),
      once('on-the-day', 'bill', 200, day(9, 21)),
      once('since', 'bill', 40, day(9, 22)),
      once('paid-in', 'income', 500, day(9, 23)),
      once('soon', 'bill', 100, day(9, 30)),
    ]
    const f = moneyForecast([chk], rows, 30, NOW)
    expect(f.days.map(d => [d.day, d.change, d.balance])).toEqual([
      [TODAY, 460, 1460],
      ['2026-09-30', -100, 1360],
    ])
    // still open, so still listed, and saying the balance has them
    const listed = comingUp([chk], rows, NOW).rows
    expect(listed.filter(r => r.inBalance).map(r => r.task.id)).toEqual(['before', 'on-the-day'])
    expect(listed.find(r => r.task.id === 'since')).toMatchObject({ due: '2026-09-22', day: TODAY, overdue: true, inBalance: false })
  })

  it('counts a done one dated since with what was paid, and a done one dated before it not at all', () => {
    const rows = [
      once('ticked', 'bill', 100, day(9, 23), { status: 'done', actualCost: 90, completedAt: day(9, 23) }),
      // nothing typed under Paid: the amount due, as withPaidDefault records it
      once('defaulted', 'bill', 60, day(9, 22), { status: 'done', completedAt: day(9, 24) }),
      once('old', 'bill', 50, day(9, 19), { status: 'done', actualCost: 50, completedAt: day(9, 19) }),
      // ticked off early: it counts on its own day, never the day it was ticked
      once('early', 'bill', 70, day(9, 28), { status: 'done', actualCost: 70, completedAt: day(9, 22) }),
    ]
    expect(moneyForecast([chk], rows, 30, NOW).days.map(d => [d.day, d.balance])).toEqual([
      [TODAY, 850],
      ['2026-09-28', 780],
    ])
    // there is nothing left to do about any of them, so none is listed
    expect(comingUp([chk], rows, NOW).rows).toEqual([])
    expect(safeToSpend([chk], rows, NOW)).toMatchObject({ amount: 780, bills: 3 })
  })

  it('never counts a paycheck twice: one already in the balance stays there when it is ticked off after', () => {
    // paid in on the 22nd, in the balance checked in on the 23rd, "Got it" on the 24th, which spawned the next
    const balance = checkedIn('2026-09-23', 3000)
    const got = once('pay', 'income', 2000, day(9, 22), { status: 'done', actualCost: 2000, completedAt: new Date(2026, 8, 24, 9).toISOString() })
    const next = money('pay~biweekly~2026-10-06', 'income', 2000, day(10, 6))
    expect(safeToSpend([balance], [got, next], NOW)).toMatchObject({ amount: 3000, paydays: 2 })
    expect(cashRunway([balance], [got, next], 30, NOW).map(d => [d.day, d.balance])).toEqual([
      ['2026-10-06', 5000],
      ['2026-10-20', 7000],
    ])
  })

  it('counts nothing at all without a balance for checking or cash', () => {
    const rows = [money('rent', 'bill', 1200, day(9, 30)), money('pay', 'income', 2000, day(9, 25))]
    const f = moneyForecast([account('sav', 'savings', [[TODAY, 9000]])], rows, 30, NOW)
    expect(f).toMatchObject({ asOf: null, days: [], counted: { bills: 0, paydays: 0, setAsides: 0 } })
    expect(safeToSpend([], rows, NOW).amount).toBeNull()
    expect(cashLine([], rows, 30, NOW)).toBeNull()
    // Coming up still lists what is written down
    expect(comingUp([], rows, NOW).rows.map(r => r.due)).toEqual(['2026-09-25', '2026-09-30', '2026-10-09', '2026-10-23'])
  })
})

describe('checking and cash checked in on different days', () => {
  // the day it counts from is the NEWEST check-in on checking and cash: an
  // account left out of it counts as it stands, and one left out by more than
  // a week is stale, and said to be

  it('counts from this morning’s checking, not from a wallet last touched in June', () => {
    // $3,000 in checking typed in today; $80 in the wallet, last typed in on
    // June 1; and every rent and paycheck of the months between, ticked off
    const chk = account('chk', 'checking', [[TODAY, 3000]])
    const wallet = account('wallet', 'cash', [['2026-06-01', 80]])
    const paid = (id: string, kind: BillKind, amount: number, dueAt: string) => once(id, kind, amount, dueAt, { status: 'done', actualCost: amount, completedAt: dueAt })
    const rows = [
      paid('rent', 'bill', 1850, day(6, 1)),
      ...[7, 8, 9].map(m => paid(`rent~monthly~2026-${String(m).padStart(2, '0')}-01`, 'bill', 1850, day(m, 1))),
      money('rent~monthly~2026-10-01', 'bill', 1850, day(10, 1)),
      paid('pay', 'income', 2450, day(6, 12)),
      ...[
        [6, 26],
        [7, 10],
        [7, 24],
        [8, 7],
        [8, 21],
        [9, 4],
        [9, 18],
      ].map(([m, d]) => paid(`pay~biweekly~2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, 'income', 2450, day(m, d))),
      money('pay~biweekly~2026-10-02', 'income', 2450, day(10, 2)),
    ]
    const f = moneyForecast([chk, wallet], rows, 30, NOW)
    // $3,080 at the end of today, and only what is dated after today on top of it
    expect(f).toMatchObject({ asOf: TODAY, checkedIn: 3080, now: 3080 })
    expect(f.days.map(d => [d.day, d.change, d.balance])).toEqual([
      ['2026-10-01', -1850, 1230],
      ['2026-10-02', 2450, 3680],
      ['2026-10-16', 2450, 6130],
    ])
    // the wallet counts as it stands, and is said to be stale
    expect(f.stale).toEqual([{ account: wallet, on: '2026-06-01' }])
    expect(safeToSpend([chk, wallet], rows, NOW)).toMatchObject({ amount: 1230, asOf: TODAY, low: '2026-10-01', bills: 1, paydays: 2, stale: [{ account: wallet, on: '2026-06-01' }] })
  })

  it('takes a check-in typed mid-week for all of it: Thursday’s checking already has Tuesday’s rent in it', () => {
    // the wallet typed in on Monday, checking on Thursday after the rent went
    const accounts = [account('wallet', 'cash', [['2026-09-21', 60]]), account('chk', 'checking', [[TODAY, 1000]])]
    const rows = [once('rent', 'bill', 500, day(9, 22)), once('phone', 'bill', 40, day(9, 26))]
    const f = moneyForecast(accounts, rows, 30, NOW)
    expect(f).toMatchObject({ asOf: TODAY, checkedIn: 1060, stale: [] })
    expect(f.days.map(d => [d.day, d.balance])).toEqual([['2026-09-26', 1020]])
    expect(comingUp(accounts, rows, NOW).rows.find(r => r.task.id === 'rent')).toMatchObject({ inBalance: true })
    expect(safeToSpend(accounts, rows, NOW)).toMatchObject({ amount: 1020, stale: [] })
  })

  it('calls an account stale once it is more than a week behind the newest, and only checking or cash', () => {
    const chk = checkedIn(TODAY, 100)
    expect(staleSpendable([chk, account('w', 'cash', [['2026-09-17', 5]])])).toEqual([])
    const late = account('w', 'cash', [['2026-09-16', 5]])
    expect(staleSpendable([chk, late])).toEqual([{ account: late, on: '2026-09-16' }])
    // savings is kept rather than spent, and a card or an archived account is not in the figure at all
    const kept = [account('sav', 'savings', [['2026-01-01', 9000]]), account('card', 'credit', [['2026-01-01', 50]]), { ...account('old', 'cash', [['2026-01-01', 5]]), archivedAt: STAMP }]
    expect(staleSpendable([chk, ...kept])).toEqual([])
    // nothing checked in, nothing to be behind
    expect(staleSpendable([account('empty', 'cash')])).toEqual([])
  })
})

describe('money in and money out alike', () => {
  it('nets a paycheck and a bill of the same size on the same day to nothing', () => {
    const chk = checkedIn(TODAY, 1000)
    const rows = [once('pay', 'income', 1500, day(10, 1)), once('rent', 'bill', 1500, day(10, 1))]
    expect(moneyForecast([chk], rows, 30, NOW).days).toEqual([expect.objectContaining({ day: '2026-10-01', change: 0, balance: 1000 })])
    expect(safeToSpend([chk], rows, NOW)).toMatchObject({ amount: 1000, low: TODAY, bills: 1, paydays: 1 })
  })

  it('moves today by a payday dated since the check-in exactly as by a bill, one up and one down', () => {
    const chk = checkedIn('2026-09-22', 1000)
    const pay = once('pay', 'income', 250, day(9, 23))
    const fee = once('fee', 'bill', 250, day(9, 23))
    expect(safeToSpend([chk], [pay], NOW).amount).toBe(1250)
    expect(safeToSpend([chk], [fee], NOW).amount).toBe(750)
    expect(safeToSpend([chk], [pay, fee], NOW).amount).toBe(1000)
  })

  it('takes a set-aside out of what can be spent, as a bill, and counts it as neither', () => {
    const s = safeToSpend([checkedIn(TODAY, 1000)], [once('fund', 'saving', 100, day(9, 28)), once('pay', 'income', 100, day(9, 29))], NOW)
    expect(s).toMatchObject({ amount: 900, low: '2026-09-28', bills: 0, paydays: 1, setAsides: 1 })
  })
})

describe('safe to spend is the lowest point of the line', () => {
  const names = { joe: 'Joe' }

  it('lands the day after a payday when a bill that size falls due then', () => {
    const rows = [money('pay', 'income', 2000, day(9, 30), { title: 'Payday', bill: { kind: 'income', forMemberId: 'joe' } }), money('rent', 'bill', 2400, day(10, 1))]
    const s = safeToSpend([checkedIn(TODAY, 500)], rows, NOW)
    expect(s).toMatchObject({ amount: 100, low: '2026-10-01', through: '2026-10-24', bills: 1, paydays: 2 })
    expect(cashLine([checkedIn(TODAY, 500)], rows, 30, NOW)?.low).toEqual({ day: '2026-10-01', balance: 100 })
    // the next payday after the low point, the one that lifts it again: the fortnight after
    expect(s.before).toMatchObject({ due: '2026-10-14', projected: true })
    expect(safeLine(s, TODAY, say(names))).toBe('Lowest on Thu, Oct 1, before Joe’s pay · counts 1 bill and 2 paydays through Oct 24')
  })

  it('is today’s balance when nothing takes the line lower', () => {
    const rows = [once('pay', 'income', 1000, day(9, 26), { title: 'Payday', bill: { kind: 'income', forMemberId: 'joe' } }), once('phone', 'bill', 500, day(10, 2))]
    const s = safeToSpend([checkedIn(TODAY, 3000)], rows, NOW)
    expect(s).toMatchObject({ amount: 3000, low: TODAY })
    expect(safeLine(s, TODAY, say(names))).toBe('Lowest today, before Joe’s pay · counts 1 bill and 1 payday through Oct 24')
  })

  it('goes below zero when the worst day is short, and says which day that is', () => {
    const rows = [once('rent', 'bill', 1200, day(9, 28)), once('pay', 'income', 900, day(10, 2))]
    const s = safeToSpend([checkedIn(TODAY, 200)], rows, NOW)
    expect(s).toMatchObject({ amount: -1000, low: '2026-09-28' })
    const line = cashLine([checkedIn(TODAY, 200)], rows, 30, NOW)!
    expect(line.short).toEqual({ day: '2026-09-28', balance: -1000 })
    expect(line.days.map(d => d.balance)).toEqual([-1000, -100])
  })

  it('names no payday when none lands after the low point in the window', () => {
    const rows = [once('pay', 'income', 800, day(9, 25)), once('insurance', 'bill', 300, day(10, 20))]
    const s = safeToSpend([checkedIn(TODAY, 1000)], rows, NOW)
    expect(s).toMatchObject({ amount: 1000, low: TODAY })
    expect(s.before?.due).toBe('2026-09-25')
    const late = safeToSpend([checkedIn(TODAY, 100)], [once('insurance', 'bill', 300, day(10, 20))], NOW)
    expect(late).toMatchObject({ amount: -200, low: '2026-10-20', before: null })
    expect(safeLine(late, TODAY, say())).toBe('Lowest on Tue, Oct 20 · counts 1 bill through Oct 24')
  })

  it('starts the line at the end of today, with what fell due since the check-in in it', () => {
    const rows = [once('since', 'bill', 300, day(9, 22)), once('pay', 'income', 1000, day(9, 30))]
    const line = cashLine([checkedIn('2026-09-21', 100)], rows, 30, NOW)!
    expect(line).toMatchObject({ from: TODAY, to: '2026-10-24', start: -200, low: { day: TODAY, balance: -200 }, high: 800, short: { day: TODAY, balance: -200 } })
    expect(line.days.map(d => d.day)).toEqual(['2026-09-30'])
  })
})

describe('a repeat nobody ticks off still comes round', () => {
  const chk = checkedIn('2026-09-22', 5000)

  it('projects an autopay rent from the day it was due, and leaves the months before the check-in in the balance', () => {
    const rent = money('rent', 'bill', 1850, day(8, 1), { title: 'Rent', bill: { kind: 'bill', autopay: true } })
    const f = moneyForecast([chk], [rent], 60, NOW)
    expect(f.rows.map(r => [r.due, r.projected, r.inBalance, r.overdue])).toEqual([
      ['2026-08-01', false, true, true],
      ['2026-10-01', true, false, false],
      ['2026-11-01', true, false, false],
    ])
    expect(f.days.map(d => [d.day, d.balance])).toEqual([
      ['2026-10-01', 3150],
      ['2026-11-01', 1300],
    ])
  })

  it('does the same for a wage paid in that nobody marks received', () => {
    const wage = money('wage', 'income', 1500, day(9, 11))
    const f = moneyForecast([chk], [wage], 30, NOW)
    expect(f.rows.map(r => [r.due, r.projected, r.inBalance])).toEqual([
      ['2026-09-11', false, true],
      ['2026-09-25', true, false],
      ['2026-10-09', true, false],
      ['2026-10-23', true, false],
    ])
    expect(f.counted.paydays).toBe(3)
  })
})

describe('a series counts once', () => {
  const chk = checkedIn(TODAY, 5000)

  it('takes two open copies of one series, ticked off on two devices, as one: the first', () => {
    const a = money('rent~monthly~2026-10-01', 'bill', 1000, day(10, 1))
    const b = money('rent~monthly~2026-10-02', 'bill', 1000, day(10, 2))
    expect(moneyForecast([chk], [b, a], 60, NOW).rows.map(r => [r.task.id, r.due])).toEqual([
      ['rent~monthly~2026-10-01', '2026-10-01'],
      ['rent~monthly~2026-10-01', '2026-11-01'],
    ])
  })

  it('counts a payday ticked off early and then reopened on its own day, beside the next one, which repeats', () => {
    // received early: the next one is spawned and takes the repeat with it;
    // reopened after, the first is an occurrence of its own again
    const first = money('pay', 'income', 2000, day(9, 26))
    const next = nextOccurrence({ ...first, status: 'done', completedAt: day(9, 24) }, () => '')!
    const reopened = { ...first, recurrence: undefined }
    const rows = comingUp([chk], [reopened, next], NOW).rows
    expect(rows.map(r => [r.task.id, r.due, r.projected])).toEqual([
      ['pay', '2026-09-26', false],
      [next.id, '2026-10-10', false],
      [next.id, '2026-10-24', true],
    ])
    expect(safeToSpend([chk], [reopened, next], NOW)).toMatchObject({ amount: 5000, paydays: 3 })
  })

  it('never projects over a day the series already has written down', () => {
    // next month's ticked off already: the open one is still this month's
    const open = money('phone', 'bill', 60, day(10, 5))
    const ahead = once('phone~monthly~2026-11-05', 'bill', 60, day(11, 5), { status: 'done', actualCost: 60, completedAt: day(9, 23) })
    const f = moneyForecast([chk], [open, ahead], 60, NOW)
    expect(f.rows.map(r => [r.due, r.done, r.projected])).toEqual([
      ['2026-10-05', false, false],
      ['2026-11-05', true, false],
    ])
    expect(f.counted.bills).toBe(2)
  })

  it('stops a series that is cancelled or back on the Wishlist, and repeats one that ran out of open ones from its last', () => {
    const gone = [money('gym', 'bill', 40, day(9, 28), { status: 'canceled' }), money('boat', 'bill', 90, day(9, 29), { status: 'wishlist' })]
    expect(moneyForecast([chk], gone, 60, NOW).rows).toEqual([])
    // done, and still repeating: nothing open was spawned (an older client)
    const last = money('water', 'bill', 45, day(9, 25), { status: 'done', actualCost: 45, completedAt: day(9, 23) })
    expect(moneyForecast([chk], [last], 60, NOW).rows.map(r => [r.due, r.done, r.projected])).toEqual([
      ['2026-09-25', true, false],
      ['2026-10-25', false, true],
    ])
  })
})

describe('money with no date', () => {
  it('is listed first, paydays leading, never counted and never dropped', () => {
    const chk = checkedIn(TODAY, 1000)
    const rows = [once('gym', 'bill', 30, undefined), money('pay-j', 'income', 2450, undefined), once('rent', 'bill', 1850, day(10, 1)), once('old', 'income', 10, undefined, { status: 'done' })]
    const c = comingUp([chk], rows, NOW)
    expect(c.undated.map(t => t.id)).toEqual(['pay-j', 'gym'])
    expect(c.rows.map(r => r.task.id)).toEqual(['rent'])
    const s = safeToSpend([chk], rows, NOW)
    expect(s).toMatchObject({ amount: -850, bills: 1, paydays: 0, undated: { bills: 1, paydays: 1, setAsides: 0 } })
    expect(undatedLine(s.undated)).toBe('1 bill and 1 payday have no date, so they aren’t counted yet.')
  })
})

describe('the owner’s own money', () => {
  // four monthly bills, each with its date and amount; two fortnightly paydays with amounts and, at first, no date
  const chk = checkedIn(TODAY, 2600)
  const bills = [
    money('car', 'bill', 142.5, day(9, 26), { title: 'Car insurance' }),
    money('rent', 'bill', 1850, day(10, 1), { title: 'Rent' }),
    money('internet', 'bill', 79.99, day(10, 8), { title: 'Internet' }),
    money('phone', 'bill', 65, day(10, 15), { title: 'Phone' }),
  ]
  const pay = (id: string, who: string, amount: number, dueAt?: string) => money(id, 'income', amount, dueAt, { title: 'Payday', bill: { kind: 'income', forMemberId: who } })
  const names = { joe: 'Joe', maria: 'Maria' }

  it('says the two paydays have no date, and counts the four bills alone until they do', () => {
    const s = safeToSpend([chk], [...bills, pay('pay-j', 'joe', 2450), pay('pay-m', 'maria', 1980)], NOW)
    expect(undatedLine(s.undated)).toBe('2 paydays have no date, so they aren’t counted yet.')
    expect(s).toMatchObject({ amount: 462.51, low: '2026-10-15', bills: 4, paydays: 0, before: null })
    expect(safeLine(s, TODAY, say(names))).toBe('Lowest on Thu, Oct 15 · counts 4 bills through Oct 24')
  })

  it('counts both once they have dates, each every time it lands in the 30 days', () => {
    const rows = [...bills, pay('pay-j', 'joe', 2450, day(10, 1)), pay('pay-m', 'maria', 1980, day(10, 2))]
    const s = safeToSpend([chk], rows, NOW)
    expect(undatedLine(s.undated)).toBeNull()
    expect(s).toMatchObject({ amount: 2457.5, low: '2026-09-26', bills: 4, paydays: 4 })
    expect(safeLine(s, TODAY, say(names))).toBe('Lowest on Sat, Sep 26, before Joe’s pay · counts 4 bills and 4 paydays through Oct 24')
    expect(
      comingUp([chk], rows, NOW)
        .rows.filter(r => r.income)
        .map(r => [r.task.id, r.due, r.projected]),
    ).toEqual([
      ['pay-j', '2026-10-01', false],
      ['pay-m', '2026-10-02', false],
      ['pay-j', '2026-10-15', true],
      ['pay-m', '2026-10-16', true],
    ])
    expect(cashRunway([chk], rows, 30, NOW).map(d => [d.day, d.balance])).toEqual([
      ['2026-09-26', 2457.5],
      ['2026-10-01', 3057.5],
      ['2026-10-02', 5037.5],
      ['2026-10-08', 4957.51],
      ['2026-10-15', 7342.51],
      ['2026-10-16', 9322.51],
    ])
  })
})

describe('what it says under the figure', () => {
  const s = (over: Partial<SafeToSpend>): SafeToSpend => ({
    amount: 100,
    spendable: 100,
    asOf: TODAY,
    low: TODAY,
    before: null,
    through: '2026-10-24',
    bills: 0,
    paydays: 0,
    setAsides: 0,
    unpriced: 0,
    undated: { bills: 0, paydays: 0, setAsides: 0 },
    unchecked: 0,
    stale: [],
    ...over,
  })

  it('lists the kinds it counted, in one breath', () => {
    expect(countsList({ bills: 5, paydays: 4, setAsides: 0 })).toBe('5 bills and 4 paydays')
    expect(countsList({ bills: 1, paydays: 1, setAsides: 1 })).toBe('1 bill, 1 payday and 1 set-aside')
    expect(countsList({ bills: 0, paydays: 0, setAsides: 2 })).toBe('2 set-asides')
    expect(countsList({ bills: 0, paydays: 0, setAsides: 0 })).toBe('')
  })

  it('says when nothing falls due at all', () => {
    expect(safeLine(s({}), TODAY, say())).toBe('Nothing falls due through Oct 24')
  })

  it('says what has no date, one or many, and nothing when all have one', () => {
    expect(undatedLine({ bills: 0, paydays: 1, setAsides: 0 })).toBe('1 payday has no date, so it isn’t counted yet.')
    expect(undatedLine({ bills: 2, paydays: 0, setAsides: 1 })).toBe('2 bills and 1 set-aside have no date, so they aren’t counted yet.')
    expect(undatedLine({ bills: 0, paydays: 0, setAsides: 0 })).toBeNull()
  })
})
