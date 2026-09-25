import { describe, expect, it } from 'vitest'
import { editedMoney } from '../billtemplates'
import { isBill, isPayday } from '../bills'
import {
  ACCOUNT_KINDS,
  accountFromForm,
  accountGroups,
  accountKindLabel,
  balanceAt,
  isLiquid,
  isSpendable,
  kindOf,
  kindParts,
  lowLine,
  moneyForecast,
  moneySeries,
  moneyTotals,
  payPeriods,
  safeToSpend,
  withBalance,
  withKind,
  type MoneyForecast,
  type MoneyRow,
} from '../finance'
import { dayLabel, moneyName, shortDay } from '../components/finance/labels'
import { sanitizeAccount, sanitizeItem, withUnknownFields } from '../schema'
import { ACCOUNT_HOLDINGS, type Account, type BillKind, type Task } from '../types'
import { shiftDayKey } from '../../shared/journal.mts'

// Finance opens on pay periods: the forecast (finance.ts, the one rule) cut
// at each payday. These hold that the cut adds nothing of its own — each
// period is the forecast's own rows, what is left at its end is the
// forecast's own line — and then the accounts' kinds: a 401(k) and a coin
// wallet are both `type: 'investment'` with what each holds beside it, which
// a phone on an older build carries along without knowing it.

/** Thursday 24 September 2026, noon: the day a view hands in (noonOf). */
const NOW = new Date(2026, 8, 24, 12, 0)
const TODAY = '2026-09-24'
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
const money = (id: string, kind: BillKind, amount: number, dueAt: string, over: Partial<Task> = {}) =>
  task(id, { bill: { kind }, estimateCost: amount, recurrence: { freq: kind === 'income' ? 'biweekly' : 'monthly' }, dueAt, ...over })
const account = (id: string, type: Account['type'], balances: [string, number][] = [], over: Partial<Account> = {}): Account =>
  balances.reduce<Account>((a, [on, amount]) => withBalance(a, amount, on), { kind: 'account', id, name: id, type, balances: [], createdAt: STAMP, updatedAt: STAMP, ...over })

/** The owner's month: two paychecks a fortnight apart and staggered, four monthly bills, and two that fell due since Tuesday's check-in. */
const joe = money('joe', 'income', 1482.45, day(9, 25), { title: 'Joe’s pay' })
const maria = money('maria', 'income', 1225.21, day(10, 2), { title: 'Maria’s pay' })
const owner = [
  joe,
  maria,
  money('car', 'bill', 184.16, day(9, 26), { title: 'Car insurance' }),
  money('rent', 'bill', 2060.3, day(10, 1), { title: 'Rent' }),
  money('internet', 'bill', 95, day(10, 8), { title: 'Internet' }),
  money('verizon', 'bill', 315.62, day(10, 15), { title: 'Verizon phone' }),
  // overdue, and due today: both after the check-in, so both count on today
  money('water', 'bill', 60, day(9, 23), { title: 'Water' }),
  money('netflix', 'bill', 15.49, day(9, 24), { title: 'Netflix' }),
]
const checking = account('chk', 'checking', [['2026-09-22', 1200]])

const titles = (rows: MoneyRow[]) => rows.map(r => `${r.task.title} ${r.due}`)
/** The forecast's own running balance at the end of `day`, read straight off its days. */
const lineAt = (f: MoneyForecast, key: string) => [...f.days].reverse().find(d => d.day <= key)?.balance ?? f.checkedIn

describe('pay periods are the forecast cut at each payday', () => {
  const f = moneyForecast([checking], owner, 30, NOW)
  const periods = payPeriods(f)

  it('starts with Now for what falls due before the first payday, then one period each paycheck, real or projected', () => {
    expect(periods.map(p => [p.key, p.from, p.to, p.paydays.map(r => `${r.task.title}${r.projected ? ' (expected)' : ''}`)])).toEqual([
      ['now', TODAY, TODAY, []],
      ['2026-09-25', '2026-09-25', '2026-10-01', ['Joe’s pay']],
      ['2026-10-02', '2026-10-02', '2026-10-08', ['Maria’s pay']],
      ['2026-10-09', '2026-10-09', '2026-10-15', ['Joe’s pay (expected)']],
      ['2026-10-16', '2026-10-16', '2026-10-22', ['Maria’s pay (expected)']],
      ['2026-10-23', '2026-10-23', '2026-10-24', ['Joe’s pay (expected)']],
    ])
    // each names the paydays that open the next, and the last runs to the window's end
    expect(periods.map(p => p.next.map(r => r.task.title))).toEqual([['Joe’s pay'], ['Maria’s pay'], ['Joe’s pay'], ['Maria’s pay'], ['Joe’s pay'], []])
    expect(periods.at(-1)!.to).toBe(f.through)
  })

  it('lists each bill in the period its day falls in, whoever’s paycheck that is, the overdue ones first', () => {
    expect(periods.map(p => titles(p.rows))).toEqual([
      ['Water 2026-09-23', 'Netflix 2026-09-24'],
      ['Car insurance 2026-09-26', 'Rent 2026-10-01'],
      ['Internet 2026-10-08'],
      ['Verizon phone 2026-10-15'],
      [],
      ['Water 2026-10-23', 'Netflix 2026-10-24'],
    ])
    expect(periods[0].rows[0]).toMatchObject({ overdue: true, day: TODAY })
    expect(periods[5].rows.every(r => r.projected)).toBe(true)
    // nothing is dropped and nothing is listed twice: every row but the paydays that open them
    const listed = periods.flatMap(p => [...p.paydays, ...p.rows])
    expect(listed).toHaveLength(f.rows.length)
    expect(new Set(listed).size).toBe(f.rows.length)
  })

  it('leaves what is left at each period’s end exactly where the forecast’s line is on that day', () => {
    for (const p of periods) expect(p.left, p.key).toBe(lineAt(f, p.to))
    expect(periods.map(p => p.left)).toEqual([1124.51, 362.5, 1492.71, 2659.54, 3884.75, 5291.71])
    // the day before the next payday lands: Wednesday the 30th for Maria's on Friday the 2nd
    expect(periods[1].to).toBe(shiftDayKey(periods[2].from, -1))
    expect(balanceAt(f, '2026-10-01')).toBe(362.5)
    // and the lowest of them is safe to spend: the line's low point is a period's end
    expect(safeToSpend([checking], owner, NOW)).toMatchObject({ amount: 362.5, low: '2026-10-01' })
  })

  it('says how much of each paycheck its bills take, past all of it when they take more', () => {
    expect(periods.map(p => [p.pay, p.out, p.share])).toEqual([
      [0, 75.49, null],
      [1482.45, 2244.46, 151],
      [1225.21, 95, 8],
      [1482.45, 315.62, 21],
      [1225.21, 0, 0],
      [1482.45, 75.49, 5],
    ])
  })

  it('looks as far as the forecast does: 60 days at a tap', () => {
    const longer = payPeriods(moneyForecast([checking], owner, 60, NOW))
    expect(longer.length).toBeGreaterThan(periods.length)
    expect(longer.slice(0, 5).map(p => p.left)).toEqual(periods.slice(0, 5).map(p => p.left))
    expect(longer.at(-1)!.to).toBe(shiftDayKey(TODAY, 60))
  })
})

describe('pay periods, at the edges', () => {
  const chk = account('chk', 'checking', [[TODAY, 500]])

  it('gives a bill due on a payday to that paycheck, as the line counts money in first on a day', () => {
    const rows = [money('pay', 'income', 1000, day(10, 2)), money('rent', 'bill', 900, day(10, 2))]
    const periods = payPeriods(moneyForecast([chk], rows, 30, NOW))
    // nothing before the payday: no Now
    expect(periods.map(p => p.key)).toEqual(['2026-10-02', '2026-10-16'])
    const [pay] = periods
    expect(pay.key).toBe('2026-10-02')
    expect(titles(pay.rows)).toEqual(['rent 2026-10-02'])
    expect(pay.share).toBe(90)
  })

  it('opens no Now when nothing falls due before the first payday, and one period for paydays that share a day', () => {
    const rows = [money('joe', 'income', 1000, day(9, 25)), money('maria', 'income', 800, day(9, 25), { recurrence: { freq: 'monthly' } })]
    const periods = payPeriods(moneyForecast([chk], rows, 30, NOW))
    expect(periods[0].key).toBe('2026-09-25')
    expect(periods[0].paydays.map(r => r.task.id)).toEqual(['joe', 'maria'])
    expect(periods[0].pay).toBe(1800)
  })

  it('is Now to the window’s end with no payday at all, and says what is left on its last day', () => {
    const periods = payPeriods(moneyForecast([chk], [money('rent', 'bill', 900, day(10, 1))], 30, NOW))
    expect(periods).toHaveLength(1)
    expect(periods[0]).toMatchObject({ key: 'now', from: TODAY, to: '2026-10-24', next: [], share: null, left: -400 })
  })

  it('lists a payday already in the balance where its day falls, and opens nothing with it', () => {
    // checked in this morning, after Joe's pay had landed and before anyone ticked it off
    const rows = [money('joe', 'income', 1000, day(9, 24)), money('rent', 'bill', 300, day(9, 24)), money('maria', 'income', 700, day(9, 30))]
    const [now, maria] = payPeriods(moneyForecast([chk], rows, 30, NOW))
    expect(now.key).toBe('now')
    expect(now.rows.map(r => [r.task.id, r.inBalance])).toEqual([
      ['joe', true],
      ['rent', true],
    ])
    // neither counts again: the check-in has them
    expect(now).toMatchObject({ out: 0, left: 500 })
    expect(maria.paydays.map(r => r.task.id)).toEqual(['maria'])
  })

  it('still cuts the periods with nothing checked in, and leaves nothing to say is left', () => {
    const periods = payPeriods(moneyForecast([], owner, 30, NOW))
    expect(periods.map(p => p.key)).toEqual(['now', '2026-09-25', '2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23'])
    expect(periods.every(p => p.left === null)).toBe(true)
    expect(periods[1].share).toBe(151)
  })

  it('counts a bill paid early, which the check-in does not have yet, in its period and out of its list', () => {
    const paid = { ...money('rent', 'bill', 900, day(10, 1)), status: 'done' as const, actualCost: 900, completedAt: day(9, 24) }
    const rows = [money('pay', 'income', 1000, day(9, 25), { recurrence: undefined }), paid]
    const [pay] = payPeriods(moneyForecast([chk], rows, 30, NOW))
    expect(pay.rows).toEqual([])
    expect(pay).toMatchObject({ out: 900, left: 600 })
  })
})

describe('the low point, as the summary says it', () => {
  const say = { day: dayLabel, short: shortDay, payday: (r: MoneyRow) => moneyName(r.task, null), bill: (r: MoneyRow) => moneyName(r.task, null) }

  it('names the payday that lifts the line after it, and with none, the bill that took it there', () => {
    const chk = account('chk', 'checking', [[TODAY, 3000]])
    expect(lowLine(safeToSpend([checking], owner, NOW), TODAY, say)).toBe('Lowest on Thu, Oct 1, before Maria’s pay')
    const car = [money('car', 'bill', 184.16, day(10, 20), { title: 'Car insurance' }), money('gym', 'bill', 30, day(10, 20), { title: 'Gym' })]
    expect(lowLine(safeToSpend([chk], car, NOW), TODAY, say)).toBe('Lowest on Tue, Oct 20, after Car insurance')
    expect(lowLine(safeToSpend([chk], [], NOW), TODAY, say)).toBe('Nothing falls due through Oct 24')
  })

  it('says nothing took it there when the line never comes down from today', () => {
    const s = safeToSpend([account('chk', 'checking', [[TODAY, 3000]])], [money('pay', 'income', 1000, day(9, 30))], NOW)
    expect(s.after).toBeNull()
    expect(lowLine(s, TODAY, say)).toBe('Lowest today, before pay')
  })
})

describe('Manage lists each series once', () => {
  it('by its soonest open occurrence, undated apart, archived ones last and never while it still runs', () => {
    const rows = [
      money('rent', 'bill', 900, day(10, 1)),
      money('rent~monthly~2026-10-01', 'bill', 900, day(11, 1)),
      money('gym', 'bill', 30, day(9, 28)),
      task('undated', { bill: { kind: 'bill' }, estimateCost: 12 }),
      money('netflix', 'bill', 15.49, day(8, 24), { status: 'canceled', updatedAt: '2026-09-02T00:00:00.000Z' }),
      money('gym~monthly~2026-08-28', 'bill', 30, day(8, 28), { status: 'canceled' }),
      money('joe', 'income', 1000, day(9, 25)),
    ]
    const bills = moneySeries(rows, isBill)
    expect(bills.dated.map(t => t.id)).toEqual(['gym', 'rent'])
    expect(bills.undated.map(t => t.id)).toEqual(['undated'])
    expect(bills.archived.map(t => t.id)).toEqual(['netflix'])
    expect(moneySeries(rows, isPayday).dated.map(t => t.id)).toEqual(['joe'])
  })
})

describe('what an investment holds', () => {
  const raw = (over: Record<string, unknown> = {}) => ({ kind: 'account', id: 'k401', name: 'Fidelity 401(k)', type: 'investment', balances: [{ on: TODAY, amount: 48210.55 }], createdAt: STAMP, updatedAt: STAMP, ...over })

  it('round-trips through sanitizeAccount and the sync pipeline, every kind of it', () => {
    for (const holding of ACCOUNT_HOLDINGS) {
      expect(sanitizeAccount(raw({ holding }))?.holding, holding).toBe(holding)
      const pulled = sanitizeItem(raw({ holding })) as Account
      expect(pulled).toMatchObject({ type: 'investment', holding })
      expect((sanitizeItem({ ...pulled, name: 'Renamed' }) as Account).holding).toBe(holding)
    }
  })

  it('survives a phone on a build from before it: carried along unknown, and back again with its edit', () => {
    // that build's sanitizer: everything this one keeps, the holding aside
    const older = (row: Record<string, unknown>): Account => {
      const { holding: _unknown, ...rest } = sanitizeAccount(row)!
      return rest
    }
    const row = raw({ holding: 'retirement' })
    const pulled = withUnknownFields(older(row), row)
    expect(pulled).toMatchObject({ type: 'investment', holding: 'retirement' })
    // its check-in: the record spread, a balance typed in, stamped newer
    const edited = { ...withBalance(pulled, 49000, '2026-09-27'), updatedAt: '2026-09-27T10:00:00.000Z' }
    const pushed = withUnknownFields(older(edited as unknown as Record<string, unknown>), edited as unknown as Record<string, unknown>)
    expect(pushed.holding).toBe('retirement')
    // …and this build reads it as it was written
    expect(sanitizeItem(pushed)).toMatchObject({ type: 'investment', holding: 'retirement', balances: [{ on: TODAY }, { on: '2026-09-27', amount: 49000 }] })
  })

  it('drops a holding that is not one of the five, and one on an account that is not an investment', () => {
    for (const bad of ['bonds', 'Crypto', '', 42, null, true, { kind: 'crypto' }, ['stocks']]) {
      const out = sanitizeItem(raw({ holding: bad })) as Account
      expect(out.holding, JSON.stringify(bad)).toBeUndefined()
      // …and nothing carries it back in as a field this build does not know
      expect(Object.prototype.hasOwnProperty.call(out, 'holding')).toBe(true)
    }
    expect(sanitizeAccount(raw({ type: 'checking', holding: 'crypto' }))?.holding).toBeUndefined()
    // no new type: one this build does not know is read as checking, as it always was
    expect(sanitizeAccount(raw({ type: 'crypto' }))?.type).toBe('checking')
  })

  it('keeps every kind of investment out of safe to spend and the money to hand, and in net worth', () => {
    const chk = account('chk', 'checking', [[TODAY, 1200]])
    for (const holding of [...ACCOUNT_HOLDINGS, undefined]) {
      const inv = account('inv', 'investment', [[TODAY, 10000]], holding ? { holding } : {})
      expect(isSpendable(inv), String(holding)).toBe(false)
      expect(isLiquid(inv), String(holding)).toBe(false)
      expect(moneyTotals([chk, inv])).toMatchObject({ spendable: 1200, liquid: 1200, net: 11200, owed: 0 })
      expect(safeToSpend([chk, inv], [], NOW).amount).toBe(1200)
    }
  })

  it('is what the picker’s nine write: a type, or for an investment what it holds', () => {
    expect(ACCOUNT_KINDS).toHaveLength(9)
    for (const kind of ACCOUNT_KINDS) expect(kindOf(kindParts(kind)), kind).toBe(kind)
    expect(kindParts('retirement')).toEqual({ type: 'investment', holding: 'retirement' })
    expect(kindParts('savings')).toEqual({ type: 'savings' })
    // one from before holdings reads as an Investment until it is given one
    const legacy = account('inv', 'investment')
    expect(kindOf(legacy)).toBeNull()
    expect(accountKindLabel(legacy)).toBe('Investment')
    expect(accountKindLabel(withKind(legacy, 'crypto'))).toBe('Crypto')
    // and stops being one when it is made a savings account
    expect(withKind(account('cb', 'investment', [], { holding: 'crypto' }), 'savings')).not.toHaveProperty('holding')
  })
})

describe('adding an account', () => {
  const o = { id: 'new', now: '2026-09-24T19:00:00.000Z', today: TODAY }

  it('needs a name: it is never called after its kind', () => {
    expect(accountFromForm({ kind: 'retirement', name: '' }, o)).toBeNull()
    expect(accountFromForm({ kind: 'crypto', name: '   ' }, o)).toBeNull()
    expect(accountFromForm({ kind: 'retirement', name: ' Fidelity 401(k) ' }, o)).toMatchObject({ kind: 'account', id: 'new', name: 'Fidelity 401(k)', type: 'investment', holding: 'retirement', balances: [] })
  })

  it('takes today’s balance with it, a card’s as what is owed, and whose it is', () => {
    expect(accountFromForm({ kind: 'crypto', name: 'Coinbase', balance: 3150.4, memberId: 'maria' }, o)).toMatchObject({ memberId: 'maria', balances: [{ on: TODAY, amount: 3150.4 }] })
    expect(accountFromForm({ kind: 'credit', name: 'Amex', balance: -640.25 }, o)).toMatchObject({ type: 'credit', balances: [{ on: TODAY, amount: 640.25 }] })
    expect(accountFromForm({ kind: 'checking', name: 'Chase checking' }, o)).not.toHaveProperty('holding')
  })
})

describe('Manage’s groups of accounts', () => {
  it('total each group by moneyTotals, and add up to the totals', () => {
    const accounts = [
      account('chk', 'checking', [[TODAY, 1200]]),
      account('cash', 'cash', [[TODAY, 80]]),
      account('rainy', 'savings', [[TODAY, 5000]]),
      account('k401', 'investment', [[TODAY, 48210.55]], { holding: 'retirement' }),
      account('cb', 'investment', [[TODAY, 3150.4]], { holding: 'crypto' }),
      account('amex', 'credit', [[TODAY, 640.25]]),
      account('old', 'checking', [[TODAY, 999]], { archivedAt: STAMP }),
    ]
    const groups = accountGroups(accounts)
    expect(groups.map(g => [g.key, g.accounts.map(a => a.id), g.total])).toEqual([
      ['spending', ['chk', 'cash'], 1280],
      ['savings', ['rainy'], 5000],
      ['investments', ['k401', 'cb'], 51360.95],
      ['owed', ['amex'], 640.25],
    ])
    const totals = moneyTotals(accounts)
    expect(Math.round((groups[0].total + groups[1].total + groups[2].total - groups[3].total) * 100) / 100).toBe(totals.net)
    expect(groups[0].total).toBe(totals.spendable)
  })
})

describe('what a bill’s or a payday’s short sheet writes', () => {
  const rent = task('rent', { title: 'Rent', bill: { kind: 'bill', emoji: '🏠', payee: 'Landlord', day: 1 }, estimateCost: 2060.3, recurrence: { freq: 'monthly' }, dueAt: new Date(2026, 9, 1, 9, 30).toISOString(), shared: true }) as Task & { bill: NonNullable<Task['bill']> }

  it('writes its fields over the occurrence and keeps the rest: the payee, the day a bill keeps, a due time left alone', () => {
    const next = editedMoney(rent, { name: ' Rent ', amount: 2100, due: '2026-10-01', freq: 'monthly', autopay: true }, '2026-09-24T20:00:00.000Z')
    expect(next).toMatchObject({ id: 'rent', title: 'Rent', estimateCost: 2100, dueAt: rent.dueAt, recurrence: { freq: 'monthly' }, shared: true, updatedAt: '2026-09-24T20:00:00.000Z' })
    expect(next.bill).toEqual({ kind: 'bill', emoji: '🏠', payee: 'Landlord', day: 1, autopay: true })
  })

  it('lands a moved one on its new day with no time, and a one-off repeats no more', () => {
    const next = editedMoney(rent, { name: 'Rent', amount: 2060.3, due: '2026-10-03', freq: null, autopay: false }, 'x')
    expect(next.dueAt).toBe(new Date(2026, 9, 3).toISOString())
    expect(next).not.toHaveProperty('recurrence')
    expect(next.bill).not.toHaveProperty('autopay')
  })

  it('says whose pay it is, or nobody’s, and leaves who can see it unless told', () => {
    const pay = task('pay', { title: 'Payday', bill: { kind: 'income', forMemberId: 'joe' }, estimateCost: 1482.45, recurrence: { freq: 'biweekly' }, dueAt: day(9, 25) }) as Task & { bill: NonNullable<Task['bill']> }
    expect(editedMoney(pay, { name: 'Maria’s pay', amount: 1225.21, due: '2026-10-02', freq: 'biweekly', whose: 'maria' }, 'x').bill).toEqual({ kind: 'income', forMemberId: 'maria' })
    expect(editedMoney(pay, { name: 'Pay', amount: 1, due: '2026-09-25', freq: 'biweekly', whose: null }, 'x').bill).toEqual({ kind: 'income' })
    expect(editedMoney(pay, { name: 'Pay', amount: 1, due: '2026-09-25', freq: 'biweekly' }, 'x')).not.toHaveProperty('shared')
    expect(editedMoney(pay, { name: 'Pay', amount: 1, due: '2026-09-25', freq: 'biweekly', shared: false }, 'x').shared).toBe(false)
  })
})
