// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Finance } from '../components/Finance'
import { DueFields } from '../components/taskeditor/DueFields'
import { CHECK_IN_PREFIX } from '../../shared/domain.mts'
import { withBalance } from '../finance'
import type { Account, Task } from '../types'

// Finance as it is drawn — by the React Compiler, as every DOM test runs it:
// the pay periods on the first run and filled in, money with no date, the +
// and what it adds, Manage and its four segments, the short sheets a bill and
// a payday open, an account's sheet and adding one by its kind, Check in, the
// weekly check-in, and the hand-off that opens Check in from its own task.

/** Wednesday 23 September 2026, noon. */
const NOW = new Date(2026, 8, 23, 12, 0)
const STAMP = '2026-09-01T00:00:00.000Z'
const JOSEPH = 'joseph'
const MARIA = 'maria'
const members = [
  { id: JOSEPH, displayName: 'Joseph' },
  { id: MARIA, displayName: 'Maria' },
]
const day = (m: number, d: number, h = 0) => new Date(2026, m - 1, d, h).toISOString()
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
const account = (id: string, name: string, type: Account['type'], balance?: [string, number], over: Partial<Account> = {}): Account => {
  const a: Account = { kind: 'account', id, name, type, balances: [], createdAt: STAMP, updatedAt: STAMP, ...over }
  return balance ? withBalance(a, balance[1], balance[0]) : a
}

const rows: Task[] = [
  task('internet', { title: 'Internet', bill: { kind: 'bill', emoji: '🌐', autopay: true }, estimateCost: 79.99, recurrence: { freq: 'monthly' }, dueAt: day(9, 22) }),
  task('netflix', { title: 'Netflix', bill: { kind: 'subscription', emoji: '🎬' }, estimateCost: 15.49, recurrence: { freq: 'monthly' }, dueAt: day(9, 24) }),
  task('pay-j', { title: 'Payday', bill: { kind: 'income', forMemberId: JOSEPH }, estimateCost: 2450, recurrence: { freq: 'biweekly' }, dueAt: day(9, 25) }),
  task('pay-m', { title: 'Payday', bill: { kind: 'income', forMemberId: MARIA }, estimateCost: 1980, recurrence: { freq: 'monthly' }, dueAt: day(10, 9) }),
  task('rent', { title: 'Rent', bill: { kind: 'bill', emoji: '🏠' }, estimateCost: 1850, recurrence: { freq: 'monthly' }, dueAt: day(10, 1) }),
  task('fund~biweekly~2026-09-26', { title: 'Emergency fund', bill: { kind: 'saving', emoji: '🛟', goal: { target: 5000, by: '2027-06-30' } }, estimateCost: 150, recurrence: { freq: 'biweekly' }, dueAt: day(9, 26) }),
  task('fund', { title: 'Emergency fund', bill: { kind: 'saving', emoji: '🛟', goal: { target: 5000, by: '2027-06-30' } }, estimateCost: 150, actualCost: 150, status: 'done', completedAt: day(9, 12, 9) }),
]
const accounts = [account('chk', 'Joint checking', 'checking', ['2026-09-21', 1420.18]), account('amex', 'Amex', 'credit', ['2026-09-14', 640.25])]

type FinanceProps = Parameters<typeof Finance>[0]
const props = (over: Partial<FinanceProps> = {}): FinanceProps => ({
  tasks: rows,
  accounts,
  members,
  myId: JOSEPH,
  inHousehold: true,
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onMarkPaid: vi.fn(),
  onAdd: vi.fn(),
  onSaveTask: vi.fn(),
  onRemoveTask: vi.fn(),
  onDeleteTask: vi.fn(),
  onArchiveTask: vi.fn(),
  onChangeAccount: vi.fn(),
  onRemoveAccount: vi.fn(),
  onCheckIn: vi.fn(),
  now: NOW,
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const dialog = () => screen.getByRole('dialog')
/** The + and one of what it adds. */
const plus = (what: 'Bill' | 'Payday' | 'Goal' | 'Check in') => {
  fireEvent.click(screen.getByRole('button', { name: 'Add to Finance' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Add to Finance' })).getByRole('button', { name: new RegExp(`^${what}`) }))
}
/** Manage, on one of its four. */
const manage = (tab: 'Bills' | 'Paydays' | 'Accounts' | 'Goals') => {
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
  fireEvent.click(within(screen.getByRole('tablist', { name: 'Manage' })).getByRole('tab', { name: tab }))
}
const card = (name: string | RegExp) => screen.getByRole('region', { name })
/** A row's name, its emoji left off. */
const named = (li: Element) => li.querySelector('.bill-copy strong')?.textContent?.replace(/^\S+\s/, '')

describe('the pay periods, on the first run', () => {
  it('asks for a check-in instead of a number, and says what each empty part is for', () => {
    render(<Finance {...props({ tasks: [], accounts: [] })} />)
    const hero = card('Safe to spend')
    expect(within(hero).getByRole('button', { name: 'Check in' })).toBeTruthy()
    expect(hero.textContent).not.toMatch(/\$/)
    expect(screen.getByText(/^Nothing due in the next 30 days/)).toBeTruthy()
    expect(within(card('Accounts')).getByRole('button', { name: /^Add an account/ })).toBeTruthy()
    // goals are drawn once there are any
    expect(screen.queryByRole('region', { name: 'Goals' })).toBeNull()
    // the old segments are gone from the landing view: a slim bar with Manage and one +
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add to Finance' })).toBeTruthy()
  })
})

describe('the pay periods, filled in', () => {
  it('says what is safe to spend: the lowest the next 30 days go, and the day, before the payday that lifts it', () => {
    render(<Finance {...props()} />)
    const hero = card('Safe to spend')
    // 1,420.18 in checking, less the internet due since the check-in and Thursday's Netflix, before Friday's pay
    expect(hero.textContent).toContain('$1,324.70')
    expect(hero.textContent).toContain('Lowest on Thu, Sep 24, before Joseph’s pay')
    expect(hero.className).not.toContain('short')
    // as old as the checking it counts: the card's older check-in (Sep 14) is not in the figure
    expect(hero.textContent).toContain('Balances as of Sep 21')
    expect(hero.textContent).not.toMatch(/no date/)
  })

  it('says so, in the shortfall ink, when the lowest day is below zero', () => {
    render(<Finance {...props({ accounts: [account('chk', 'Joint checking', 'checking', ['2026-09-21', 50])] })} />)
    const hero = card('Safe to spend')
    expect(hero.className).toContain('short')
    expect(hero.textContent).toContain('-$45.48')
    expect(hero.textContent).toContain('Lowest on Thu, Sep 24, before Joseph’s pay')
    // …and when it first goes under, in the words it always has: today, with the internet out
    expect(within(hero).getByText(/^On Wed, Sep 23 the money you can actually spend goes to -\$29\.99 — counting only what is written down\.$/)).toBeTruthy()
  })

  it('cuts the next 30 days at each payday: Now first, then a card for each paycheck with what it covers', () => {
    render(<Finance {...props()} />)
    const periods = within(card('Pay periods')).getAllByRole('region')
    // on a day two land, the real one first and the one a repeat brings after it (the forecast's order)
    expect(periods.map(p => p.getAttribute('aria-label'))).toEqual(['Now', 'Joseph’s pay · Fri, Sep 25', 'Maria’s pay and Joseph’s pay · Fri, Oct 9', 'Joseph’s pay · Fri, Oct 23'])
    const [now, first, both, last] = periods
    // what falls due before the first payday: overdue first
    const nowRows = within(now).getAllByRole('listitem')
    expect(nowRows.map(named)).toEqual(['Internet', 'Netflix'])
    expect(nowRows[0].className).toContain('overdue')
    expect(nowRows[0].textContent).toContain('Overdue')
    expect(nowRows[0].textContent).toContain('Autopay')
    expect(now.textContent).toContain('Before Joseph’s pay')
    // the paycheck, with the plus of money in, and Got it on the real one
    expect(first.querySelector('.fin-payday')?.textContent).toContain('+$2,450.00')
    expect(within(first).getByRole('button', { name: 'Mark Joseph’s pay received' })).toBeTruthy()
    expect(within(first).getAllByRole('listitem').map(named)).toEqual(['Emergency fund', 'Rent'])
    // two paydays on one day are one card, whoever's they are
    expect(both.querySelectorAll('.fin-payday')).toHaveLength(2)
    expect(within(both).getAllByRole('listitem').map(named)).toEqual(['Emergency fund', 'Internet'])
    expect(within(last).queryAllByRole('listitem')).toHaveLength(0)
    expect(last.textContent).toContain('Nothing falls due.')
  })

  it('says how much of each paycheck its stretch takes, past all of it in the warning ink', () => {
    render(<Finance {...props()} />)
    const first = card('Joseph’s pay · Fri, Sep 25')
    // the fund and the rent: 2,000 of 2,450
    expect(first.querySelector('.fin-take')?.textContent).toBe('$2,000.00 due · 82% of this pay')
    expect(first.querySelector('.fin-take')?.className).not.toContain('over')
    expect((first.querySelector('.fin-take-bar > span') as HTMLElement).style.width).toBe('82%')
    const lean = render(<Finance {...props({ tasks: rows.map(t => (t.id === 'pay-j' ? { ...t, estimateCost: 1500 } : t)) })} />)
    const over = within(lean.container).getByRole('region', { name: 'Joseph’s pay · Fri, Sep 25' }).querySelector('.fin-take')
    expect(over?.className).toContain('over')
    expect(over?.textContent).toBe('$2,000.00 due · 133% of this pay')
    expect((over?.querySelector('.fin-take-bar > span') as HTMLElement).style.width).toBe('100%')
  })

  it('ends each card on what the line leaves the day before the next payday, and the last on the window’s end', () => {
    render(<Finance {...props()} />)
    const left = within(card('Pay periods'))
      .getAllByRole('region')
      .map(p => p.querySelector('.fin-period-left')?.textContent)
    expect(left).toEqual(['Left before Joseph’s pay$1,324.70', 'Left before Maria’s pay and Joseph’s pay$1,774.70', 'Left before Joseph’s pay$5,974.71', 'Left on Oct 23$8,424.71'])
  })

  it('draws what repeats bring quieter and with nothing to tick', () => {
    render(<Finance {...props()} />)
    const expected = within(card('Pay periods'))
      .getAllByRole('listitem')
      .filter(li => li.className.includes('projected'))
    expect(expected.map(li => [li.querySelector('.fin-date')?.textContent, named(li)])).toEqual([
      ['Sat 10', 'Emergency fund'],
      ['Thu 22', 'Internet'],
    ])
    for (const li of expected) {
      expect(li.textContent).toContain('Expected')
      expect(within(li).queryByRole('button', { name: /^Mark / })).toBeNull()
    }
    // only the open paycheck can be marked received; the ones its repeat brings say Expected
    expect(screen.getAllByRole('button', { name: 'Mark Joseph’s pay received' })).toHaveLength(1)
    expect(card('Joseph’s pay · Fri, Oct 23').querySelector('.fin-payday.projected')?.textContent).toContain('Expected')
  })

  it('marks a bill paid and a payday received the way it always has', () => {
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark Netflix paid' }))
    expect(p.onMarkPaid).toHaveBeenCalledWith(rows[1])
    fireEvent.click(screen.getByRole('button', { name: 'Mark Joseph’s pay received' }))
    expect(p.onMarkPaid).toHaveBeenLastCalledWith(rows[2])
    fireEvent.click(screen.getByRole('button', { name: 'Mark Emergency fund set aside' }))
    expect(p.onMarkPaid).toHaveBeenLastCalledWith(rows[5])
  })

  it('looks 30 days further at a tap, and back', () => {
    render(<Finance {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show 30 more days' }))
    expect(within(card('Pay periods')).getByText('next 60 days')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Joseph’s pay · Fri, Nov 6' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to 30 days' }))
    expect(screen.queryByRole('region', { name: 'Joseph’s pay · Fri, Nov 6' })).toBeNull()
  })

  it('keeps the cash line a tap away, with its low point named, and 60 days at another', () => {
    render(<Finance {...props()} />)
    fireEvent.click(within(card('Safe to spend')).getByRole('button', { name: 'See the line' }))
    const sheet = screen.getByRole('dialog', { name: 'Cash, next 30 days' })
    const chart = within(sheet).getByRole('button', { name: /^Spendable cash over the next 30 days/ })
    expect(chart.getAttribute('aria-label')).toContain('lowest $1,324.70 on Thu, Sep 24')
    expect(chart.textContent).toContain('Low point $1,324.70 · Sep 24')
    fireEvent.click(chart)
    expect(screen.getByRole('dialog', { name: 'Cash, next 60 days' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '60 days', pressed: true })).toBeTruthy()
  })

  it('shows the accounts as a strip, a card as owed, each opening its own sheet', () => {
    render(<Finance {...props()} />)
    const amex = screen.getByRole('button', { name: /^Amex: \$640\.25 owed, as of Sep 14/ })
    expect(amex.querySelector('strong')?.className).toBe('owed')
    expect(screen.getByRole('button', { name: /^Joint checking: \$1,420\.18, 2d/ })).toBeTruthy()
    fireEvent.click(amex)
    expect(screen.getByRole('dialog', { name: /Amex/ })).toBeTruthy()
    expect((within(dialog()).getByLabelText('Name') as HTMLInputElement).value).toBe('Amex')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    // and Check in, on every account, at the end of the strip
    fireEvent.click(within(card('Accounts')).getByRole('button', { name: /^Check in/ }))
    expect(within(dialog()).getByRole('heading', { name: 'Check in' })).toBeTruthy()
  })

  it('shows a goal as a row with its bar, what it has saved and whether it is on track', () => {
    const p = props()
    render(<Finance {...p} />)
    const goals = card('Goals')
    expect(goals.textContent).toContain('Emergency fund')
    expect(goals.textContent).toContain('$150.00 of $5,000.00 · by Jun 30')
    expect(goals.textContent).toContain('Behind')
    fireEvent.click(within(goals).getByRole('button', { name: /Emergency fund/ }))
    expect(p.onOpen).toHaveBeenCalledWith(rows[5])
  })
})

describe('money with no date', () => {
  const bonus = task('bonus', { title: 'Payday', bill: { kind: 'income', forMemberId: MARIA }, estimateCost: 500, recurrence: { freq: 'biweekly' } })
  const gym = task('gym', { title: 'Gym', bill: { kind: 'subscription' }, estimateCost: 30, recurrence: { freq: 'monthly' } })

  it('comes first under Needs a date, is left out of safe to spend, and the figure says so', () => {
    render(<Finance {...props({ tasks: [...rows, gym, bonus] })} />)
    const plan = card('Pay periods')
    const needs = within(plan).getByRole('region', { name: 'Needs a date' })
    expect(plan.firstElementChild).toBe(needs)
    const items = within(needs).getAllByRole('listitem')
    expect(items.map(named)).toEqual(['Maria’s pay', 'Gym'])
    expect(items[0].textContent).toContain('+$500.00')
    expect(items[0].textContent).toContain('Not counted')
    const hero = card('Safe to spend')
    expect(hero.textContent).toContain('$1,324.70')
    expect(hero.textContent).toContain('1 bill and 1 payday have no date, so they aren’t counted yet.')
  })

  it('takes a date where it is listed, and saves it as the day with no time', () => {
    const p = props({ tasks: [...rows, bonus] })
    render(<Finance {...p} />)
    const field = screen.getByLabelText('Maria’s pay: next date') as HTMLInputElement
    expect(field.type).toBe('date')
    expect(field.className).toContain('fin-date-input')
    // a year typed a digit at a time passes through years nobody means
    fireEvent.change(field, { target: { value: '0002-09-30' } })
    expect(p.onSaveTask).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '2026-09-30' } })
    expect(p.onSaveTask).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(p.onSaveTask).mock.calls[0][0]
    expect(saved).toMatchObject({ id: 'bonus', title: 'Payday', estimateCost: 500, bill: { kind: 'income', forMemberId: MARIA } })
    expect(saved.dueAt).toBe(new Date(2026, 8, 30).toISOString())
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(bonus.updatedAt))
  })

  it('opens its short sheet at a tap, which will not save it without a date', () => {
    const p = props({ tasks: [...rows, gym] })
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Gym/ }))
    const sheet = screen.getByRole('dialog', { name: /Gym/ })
    const save = within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(within(sheet).getByText(/cannot without one/)).toBeTruthy()
    fireEvent.change(within(sheet).getByLabelText('Next due'), { target: { value: '2026-09-28' } })
    fireEvent.click(save)
    expect(vi.mocked(p.onSaveTask).mock.calls[0][0]).toMatchObject({ id: 'gym', dueAt: new Date(2026, 8, 28).toISOString(), estimateCost: 30 })
  })

  it('asks for a date in the editor too, on money and nothing else', () => {
    const form = { dueAt: '', completedAt: '', status: 'todo' as const, bill: { kind: 'income' as const } }
    const view = render(<DueFields form={form} set={vi.fn()} />)
    expect(screen.getByText('Add a date so Finance can count it.')).toBeTruthy()
    view.rerender(<DueFields form={{ ...form, dueAt: '2026-09-30T00:00' }} set={vi.fn()} />)
    expect(screen.queryByText('Add a date so Finance can count it.')).toBeNull()
    view.rerender(<DueFields form={{ ...form, bill: undefined }} set={vi.fn()} />)
    expect(screen.queryByText('Add a date so Finance can count it.')).toBeNull()
  })
})

describe('the +', () => {
  it('offers a bill, a payday, a goal and a check-in, each opening its own sheet', () => {
    render(<Finance {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to Finance' }))
    const sheet = screen.getByRole('dialog', { name: 'Add to Finance' })
    expect(within(sheet).getAllByRole('button', { name: /^(Bill|Payday|Goal|Check in)/ }).map(b => b.querySelector('strong')?.textContent)).toEqual(['Bill', 'Payday', 'Goal', 'Check in'])
    fireEvent.click(within(sheet).getByRole('button', { name: /^Goal/ }))
    expect(screen.getByRole('dialog', { name: 'New goal' })).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    plus('Check in')
    expect(within(dialog()).getByRole('heading', { name: 'Check in' })).toBeTruthy()
  })
})

describe('+ Payday', () => {
  it('will not add a payday without the date of the next one, then adds it whole', () => {
    const p = props()
    render(<Finance {...p} />)
    plus('Payday')
    // the reader's own pay, named for them, until someone else is picked
    const sheet = screen.getByRole('dialog', { name: '💵 Joseph’s pay' })
    expect(within(sheet).getByRole('button', { name: 'Joseph', pressed: true })).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Maria' }))
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('Maria’s pay')
    expect(within(sheet).getByRole('button', { name: 'Every 2 weeks', pressed: true })).toBeTruthy()
    fireEvent.change(within(sheet).getByLabelText('Take-home pay'), { target: { value: '1,980' } })
    const add = within(sheet).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.click(add)
    expect(p.onAdd).not.toHaveBeenCalled()
    expect(within(sheet).getByText(/Finance counts every payday from its date/)).toBeTruthy()
    const date = within(sheet).getByLabelText('Next payday') as HTMLInputElement
    expect(date.type).toBe('date')
    expect(date.required).toBe(true)
    fireEvent.change(date, { target: { value: '2026-10-02' } })
    expect(add.disabled).toBe(false)
    fireEvent.click(add)
    expect(p.onAdd).toHaveBeenCalledTimes(1)
    const [payday, message] = vi.mocked(p.onAdd).mock.calls[0]
    expect(payday).toMatchObject({ title: 'Maria’s pay', status: 'todo', estimateCost: 1980, recurrence: { freq: 'biweekly' }, bill: { kind: 'income', forMemberId: MARIA }, shared: true })
    expect(payday.dueAt).toBe(new Date(2026, 9, 2).toISOString())
    expect(message).toBe('Added “Maria’s pay”')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a name typed over, takes weekly or monthly pay, and hands the rest to the full editor', () => {
    const p = props()
    render(<Finance {...p} />)
    manage('Paydays')
    fireEvent.click(screen.getByRole('button', { name: '+ Payday' }))
    const sheet = dialog()
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Acme wages' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Maria' }))
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('Acme wages')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Monthly' }))
    fireEvent.change(within(sheet).getByLabelText('Take-home pay'), { target: { value: '4200' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'More options…' }))
    expect(p.onNew).toHaveBeenCalledWith({ title: 'Acme wages', bill: { kind: 'income', forMemberId: MARIA }, recurrence: { freq: 'monthly' }, estimateCost: 4200, shared: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('alone, asks nobody whose it is or who can see it', () => {
    const p = props({ members: [], myId: null, inHousehold: false })
    render(<Finance {...p} />)
    plus('Payday')
    const sheet = screen.getByRole('dialog', { name: '💵 Payday' })
    expect(within(sheet).queryByText('Whose pay')).toBeNull()
    expect(within(sheet).queryByText('Who can see it')).toBeNull()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Weekly' }))
    fireEvent.change(within(sheet).getByLabelText('Take-home pay'), { target: { value: '640' } })
    fireEvent.change(within(sheet).getByLabelText('Next payday'), { target: { value: '2026-09-25' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    const [payday] = vi.mocked(p.onAdd).mock.calls[0]
    expect(payday).toMatchObject({ title: 'Payday', estimateCost: 640, recurrence: { freq: 'weekly' }, bill: { kind: 'income' }, shared: false })
    expect(payday.bill?.forMemberId).toBeUndefined()
  })
})

describe('+ Bill', () => {
  it('fills in a template, and adds it with what only you know', () => {
    const p = props()
    render(<Finance {...p} />)
    plus('Bill')
    const picker = dialog()
    expect(within(picker).getByRole('heading', { name: 'Add a bill' })).toBeTruthy()
    for (const name of ['Rent', 'Mortgage', 'Electric', 'Water & sewer', 'Netflix', 'Spotify', 'YouTube Premium', 'Apple', 'Credit card', 'Other']) {
      expect(within(picker).getByRole('button', { name })).toBeTruthy()
    }
    fireEvent.click(within(picker).getByRole('button', { name: 'Electric' }))
    const form = dialog()
    const add = within(form).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Electric')
    expect((within(form).getByLabelText('Repeats') as HTMLSelectElement).value).toBe('monthly')
    fireEvent.change(within(form).getByLabelText('Amount due'), { target: { value: '$142.60' } })
    fireEvent.change(within(form).getByLabelText('Next due'), { target: { value: '2026-09-28' } })
    fireEvent.click(within(form).getByLabelText('Paid automatically'))
    expect(add.disabled).toBe(false)
    fireEvent.click(add)
    expect(p.onAdd).toHaveBeenCalledTimes(1)
    const [bill, message] = vi.mocked(p.onAdd).mock.calls[0]
    expect(bill).toMatchObject({ title: 'Electric', estimateCost: 142.6, recurrence: { freq: 'monthly' }, bill: { kind: 'bill', emoji: '⚡', autopay: true }, shared: true, status: 'todo' })
    expect(bill.dueAt).toBe(new Date(2026, 8, 28).toISOString())
    expect(message).toBe('Added “Electric”')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says what Add is waiting for, and says it with Add, until nothing is missing', () => {
    render(<Finance {...props()} />)
    plus('Bill')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Electric' }))
    const add = within(dialog()).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    const said = () => document.getElementById(add.getAttribute('aria-describedby') ?? '')?.textContent
    expect(add.disabled).toBe(true)
    expect(said()).toBe('Add needs the amount and the day it is next due: Finance counts a bill from its date, the way it counts paydays.')
    fireEvent.change(within(dialog()).getByLabelText('Amount due'), { target: { value: '142.60' } })
    expect(said()).toBe('Add needs the day it is next due: Finance counts a bill from its date, the way it counts paydays.')
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: '' } })
    fireEvent.change(within(dialog()).getByLabelText('Next due'), { target: { value: '2026-09-28' } })
    expect(said()).toBe('Add needs a name.')
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'Electric' } })
    expect(add.disabled).toBe(false)
    expect(add.getAttribute('aria-describedby')).toBeNull()
    expect(screen.queryByText(/^Add needs/)).toBeNull()
  })

  it('hands anything the short form leaves out to the full editor, as filled in so far', () => {
    const p = props({ inHousehold: false })
    render(<Finance {...p} />)
    plus('Bill')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Netflix' }))
    // alone, there is no one to share it with, and no choice to make
    expect(within(dialog()).queryByText('Who can see it')).toBeNull()
    fireEvent.change(within(dialog()).getByLabelText('Amount due'), { target: { value: '15.49' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'More options…' }))
    expect(p.onNew).toHaveBeenCalledWith({ title: 'Netflix', bill: { kind: 'subscription', emoji: '🎬' }, recurrence: { freq: 'monthly' }, estimateCost: 15.49 })
  })
})

describe('the short sheets', () => {
  it('edit a bill: its name, amount, next date, how often and autopay, keeping the rest', () => {
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Thu 24 Netflix/ }))
    const sheet = screen.getByRole('dialog', { name: '🎬 Netflix' })
    expect((within(sheet).getByLabelText('Amount due') as HTMLInputElement).value).toBe('15.49')
    expect((within(sheet).getByLabelText('Next due') as HTMLInputElement).value).toBe('2026-09-24')
    expect((within(sheet).getByLabelText('Repeats') as HTMLSelectElement).value).toBe('monthly')
    expect(within(sheet).getByRole('button', { name: 'More options…' })).toBeTruthy()
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Netflix Premium' } })
    fireEvent.change(within(sheet).getByLabelText('Amount due'), { target: { value: '22.99' } })
    fireEvent.change(within(sheet).getByLabelText('Next due'), { target: { value: '2026-09-27' } })
    fireEvent.click(within(sheet).getByLabelText('Paid automatically'))
    // the date is required: cleared, it will not save
    const save = within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    fireEvent.change(within(sheet).getByLabelText('Next due'), { target: { value: '' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(within(sheet).getByLabelText('Next due'), { target: { value: '2026-09-27' } })
    fireEvent.click(save)
    expect(p.onSaveTask).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(p.onSaveTask).mock.calls[0][0]
    expect(saved).toMatchObject({ id: 'netflix', title: 'Netflix Premium', estimateCost: 22.99, recurrence: { freq: 'monthly' }, bill: { kind: 'subscription', emoji: '🎬', autopay: true } })
    expect(saved.dueAt).toBe(new Date(2026, 8, 27).toISOString())
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(rows[1].updatedAt))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('edit a payday: whose, take-home pay, the next date and how often', () => {
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Joseph’s pay Fri, Sep 25/ }))
    const sheet = screen.getByRole('dialog', { name: '💵 Joseph’s pay' })
    expect(within(sheet).getByRole('button', { name: 'Joseph', pressed: true })).toBeTruthy()
    expect((within(sheet).getByLabelText('Take-home pay') as HTMLInputElement).value).toBe('2450.00')
    expect(within(sheet).getByRole('button', { name: 'Every 2 weeks', pressed: true })).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Maria' }))
    fireEvent.change(within(sheet).getByLabelText('Take-home pay'), { target: { value: '2,510.40' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Monthly' }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }))
    const saved = vi.mocked(p.onSaveTask).mock.calls[0][0]
    expect(saved).toMatchObject({ id: 'pay-j', title: 'Payday', estimateCost: 2510.4, recurrence: { freq: 'monthly' }, bill: { kind: 'income', forMemberId: MARIA } })
    // the day was left alone, so the time it had is kept
    expect(saved.dueAt).toBe(rows[2].dueAt)
  })

  it('say a payday has no owner yet, rather than light a member for it', () => {
    const nobody = task('pay-x', { title: 'Bonus', bill: { kind: 'income' }, estimateCost: 500, recurrence: { freq: 'monthly' }, dueAt: day(10, 5) })
    const p = props({ tasks: [...rows, nobody] })
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Bonus Mon, Oct 5/ }))
    const sheet = screen.getByRole('dialog', { name: '💵 Bonus' })
    expect(within(sheet).getByRole('button', { name: 'Not said', pressed: true })).toBeTruthy()
    expect(within(sheet).getByRole('button', { name: 'Joseph', pressed: false })).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Maria' }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }))
    expect(vi.mocked(p.onSaveTask).mock.calls[0][0]).toMatchObject({ id: 'pay-x', bill: { kind: 'income', forMemberId: MARIA } })
  })

  it('archive a bill, delete one, and hand the rest to the full editor, saving what was changed first', () => {
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Thu 1 Rent/ }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Archive' }))
    expect(p.onArchiveTask).toHaveBeenCalledWith(rows[4], true)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Thu 1 Rent/ }))
    const del = within(dialog()).getByRole('button', { name: 'Delete' })
    fireEvent.click(del)
    expect(p.onDeleteTask).not.toHaveBeenCalled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete it?' }))
    expect(p.onDeleteTask).toHaveBeenCalledWith(rows[4])

    fireEvent.click(screen.getByRole('button', { name: /^Thu 1 Rent/ }))
    fireEvent.change(within(dialog()).getByLabelText('Amount due'), { target: { value: '1900' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'More options…' }))
    const saved = vi.mocked(p.onSaveTask).mock.calls[0][0]
    expect(saved).toMatchObject({ id: 'rent', estimateCost: 1900 })
    expect(p.onOpen).toHaveBeenCalledWith(saved)
  })

  it('ask in the app before throwing away what was typed: on More options when it cannot be saved, and on Cancel', () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Thu 1 Rent/ }))
    fireEvent.change(within(dialog()).getByLabelText('Amount due'), { target: { value: 'lots' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'More options…' }))
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Keep editing' }))
    expect(p.onOpen).not.toHaveBeenCalled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'More options…' }))
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard' }))
    // what could not be saved is left behind, and the editor opens on the bill as it was
    expect(p.onSaveTask).not.toHaveBeenCalled()
    expect(p.onOpen).toHaveBeenCalledWith(rows[4])

    plus('Payday')
    fireEvent.change(within(dialog()).getByLabelText('Next payday'), { target: { value: '2026-10-09' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('bring an archived one back from Manage', () => {
    const stopped = task('gym', { title: 'Gym', bill: { kind: 'subscription', emoji: '🏋️' }, estimateCost: 30, recurrence: { freq: 'monthly' }, dueAt: day(9, 28), status: 'canceled' })
    const p = props({ tasks: [...rows, stopped] })
    render(<Finance {...p} />)
    manage('Bills')
    const archived = screen.getByRole('group', { name: 'Archived' })
    fireEvent.click(within(archived).getByRole('button', { name: /^Gym/ }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Restore' }))
    expect(p.onArchiveTask).toHaveBeenCalledWith(stopped, false)
  })
})

describe('Manage', () => {
  it('is a screen of its own, with a way back, over four segments', () => {
    render(<Finance {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(screen.getByRole('heading', { name: 'Manage' })).toBeTruthy()
    const tabs = within(screen.getByRole('tablist', { name: 'Manage' })).getAllByRole('tab')
    expect(tabs.map(t => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Bills', 'true'],
      ['Paydays', 'false'],
      ['Accounts', 'false'],
      ['Goals', 'false'],
    ])
    // the pay periods are behind it, not beside it
    expect(screen.queryByRole('region', { name: 'Safe to spend' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('region', { name: 'Safe to spend' })).toBeTruthy()
  })

  it('lists every bill soonest first, one row a series, with the month of bills and what was paid under them', () => {
    const gym = task('gym', { title: 'Gym', bill: { kind: 'subscription', payee: 'A gym with a very long name indeed' }, estimateCost: 30, recurrence: { freq: 'monthly' } })
    render(<Finance {...props({ tasks: [...rows, gym] })} />)
    manage('Bills')
    // one with no date first, saying so in the warning ink
    const needs = screen.getByRole('group', { name: 'Needs a date' })
    expect(within(needs).getAllByRole('listitem').map(named)).toEqual(['Gym'])
    const list = screen.getByRole('region', { name: 'Every bill' }).querySelector('.fin-list')!
    const items = within(list as HTMLElement).getAllByRole('listitem')
    expect(items.map(li => li.querySelector('.bill-copy strong')?.textContent)).toEqual(['Internet', 'Netflix', 'Rent'])
    expect(items.map(li => li.querySelector('.bill-copy small')?.textContent)).toEqual(['Next: Tue, Sep 22 · Monthly · Autopay', 'Next: Thu, Sep 24 · Monthly', 'Next: Thu, Oct 1 · Monthly'])
    expect(items.map(li => li.querySelector('.bill-amount')?.textContent)).toEqual(['$79.99', '$15.49', '$1,850.00'])
    // the month of bills, as it was
    const month = screen.getByRole('group', { name: 'Month by month' })
    expect(within(month).getByText('Still to pay')).toBeTruthy()
    expect(within(month).getByText('September 2026')).toBeTruthy()
    // and an average month, in and out, over the segments: the gym with no date still costs one
    const average = document.querySelector('.fin-month')?.textContent ?? ''
    expect(average).toContain('$1,975.48 out')
    expect(average).toContain('$325.00 of it set aside')
  })

  it('lists the paydays soonest first, whose each is and how often, and No date yet where there is none', () => {
    const nodate = task('bonus', { title: 'Payday', bill: { kind: 'income', forMemberId: MARIA }, estimateCost: 500, recurrence: { freq: 'biweekly' } })
    render(<Finance {...props({ tasks: [...rows, nodate] })} />)
    manage('Paydays')
    expect(within(screen.getByRole('group', { name: 'Needs a date' })).getAllByRole('listitem').map(named)).toEqual(['Maria’s pay'])
    const list = screen.getByRole('region', { name: 'Every payday' }).querySelector('.fin-list') as HTMLElement
    const items = within(list).getAllByRole('listitem')
    expect(items.map(li => li.querySelector('.bill-copy strong')?.textContent)).toEqual(['Joseph’s pay', 'Maria’s pay'])
    expect(items.map(li => li.querySelector('.bill-copy small')?.textContent)).toEqual(['Next: Fri, Sep 25 · Joseph · Every 2 weeks', 'Next: Fri, Oct 9 · Maria · Monthly'])
    expect(items[0].querySelector('.bill-amount')?.textContent).toBe('+$2,450.00')
  })

  it('groups the accounts with a subtotal each, then the totals and the weekly check-in', () => {
    const more = [
      ...accounts,
      account('k401', 'Fidelity 401(k)', 'investment', ['2026-09-20', 48210.55], { holding: 'retirement' }),
      account('cb', 'Coinbase', 'investment', ['2026-09-23', 3150.4], { holding: 'crypto' }),
      account('inv', 'Investment', 'investment', ['2026-09-14', 12000]),
      account('rainy', 'Rainy day', 'savings', ['2026-09-21', 5000]),
    ]
    render(<Finance {...props({ accounts: more })} />)
    manage('Accounts')
    const group = (name: string) => screen.getByRole('region', { name })
    expect(group('Spending').textContent).toContain('Counted in safe to spend')
    expect(group('Spending').querySelector('.fin-group-head > strong')?.textContent).toBe('$1,420.18')
    expect(group('Savings').querySelector('.fin-group-head > strong')?.textContent).toBe('$5,000.00')
    const investments = within(group('Investments')).getAllByRole('listitem')
    expect(investments.map(li => [li.querySelector('.bill-copy strong')?.textContent, li.querySelector('.bill-copy small')?.textContent])).toEqual([
      ['Fidelity 401(k)', 'Retirement · 3d'],
      ['Coinbase', 'Crypto · today'],
      // one from before holdings reads as an Investment until it is given one
      ['Investment', 'Investment · as of Sep 14'],
    ])
    expect(group('Investments').querySelector('.fin-group-head > strong')?.textContent).toBe('$63,360.95')
    expect(group('Owed').querySelector('.fin-group-head > strong')?.textContent).toBe('$640.25')
    const totals = screen.getByRole('list', { name: 'Totals' })
    expect(totals.textContent).toContain('Net worth$69,140.88')
    expect(totals.textContent).toContain('Spendable today$1,420.18')
    expect(totals.textContent).toContain('Owed$640.25')
    expect(screen.getByLabelText('Check in weekly')).toBeTruthy()
  })

  it('shows each goal in full, and adds one', () => {
    render(<Finance {...props()} />)
    manage('Goals')
    const goals = screen.getByRole('region', { name: 'Goals' })
    expect(goals.textContent).toContain('$150.00 of $5,000.00 · by Jun 30')
    expect(goals.textContent).toContain('$150.00 every 2 weeks · next Sep 26')
    fireEvent.click(within(goals).getByRole('button', { name: '+ Goal' }))
    expect(screen.getByRole('dialog', { name: 'New goal' })).toBeTruthy()
  })
})

describe('an account', () => {
  it('is added by its kind first, then a name it will not do without', () => {
    const p = props()
    render(<Finance {...p} />)
    manage('Accounts')
    fireEvent.click(screen.getByRole('button', { name: '+ Account' }))
    const kinds = within(screen.getByRole('dialog', { name: 'Add an account' })).getByRole('radiogroup', { name: 'What kind of account' })
    expect(within(kinds).getAllByRole('radio').map(r => r.querySelector('.fin-kind-name')?.textContent)).toEqual([
      'Checking',
      'Savings',
      'Cash',
      'Credit card',
      'Stocks & funds',
      'Retirement',
      'Crypto',
      'HSA',
      'Other investment',
    ])
    fireEvent.click(within(kinds).getByRole('radio', { name: 'Retirement' }))
    const sheet = screen.getByRole('dialog', { name: '🏖️ Retirement' })
    expect(sheet.textContent).toContain('Retirement (401(k), IRA)')
    const name = within(sheet).getByLabelText('Name') as HTMLInputElement
    expect(name.placeholder).toBe('e.g. Fidelity 401(k)')
    const add = within(sheet).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    // no name, no account: never one called after its kind
    expect(add.disabled).toBe(true)
    fireEvent.change(within(sheet).getByLabelText('Balance today'), { target: { value: '48,210.55' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(name, { target: { value: '   ' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(name, { target: { value: 'Fidelity 401(k)' } })
    fireEvent.click(add)
    const [before, after, message] = vi.mocked(p.onChangeAccount).mock.calls[0]
    expect(before).toBeNull()
    expect(after).toMatchObject({ kind: 'account', name: 'Fidelity 401(k)', type: 'investment', holding: 'retirement', balances: [{ on: '2026-09-23', amount: 48210.55 }] })
    expect(message).toBe('Added “Fidelity 401(k)”')
  })

  it('is renamed, given another kind and whose it is in its sheet, with today’s balance and its last few', () => {
    const legacy = withBalance(account('inv', 'Investment', 'investment', ['2026-09-07', 11800]), 12000, '2026-09-14')
    const p = props({ accounts: [...accounts, legacy] })
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Investment: \$12,000\.00/ }))
    const sheet = screen.getByRole('dialog', { name: /Investment/ })
    // no holding written yet: nothing picked, and it says so
    const kinds = within(sheet).getByRole('radiogroup', { name: 'Kind of account' })
    expect(within(kinds).queryByRole('radio', { checked: true })).toBeNull()
    expect(sheet.textContent).toContain('Investment — pick what it holds')
    // the balances typed in, newest first, and how each moved
    expect([...sheet.querySelectorAll('.fin-history-list li')].map(li => li.textContent)).toEqual(['Sep 14↑ $200.00$12,000.00', 'Sep 7$11,800.00'])
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Coinbase' } })
    fireEvent.click(within(kinds).getByRole('radio', { name: 'Crypto' }))
    expect(within(kinds).getByRole('radio', { name: 'Crypto' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Maria' }))
    fireEvent.change(within(sheet).getByLabelText('Balance today'), { target: { value: '$3,150.40' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }))
    const [before, after, message] = vi.mocked(p.onChangeAccount).mock.calls[0]
    expect(before).toBe(legacy)
    expect(after).toMatchObject({ id: 'inv', name: 'Coinbase', type: 'investment', holding: 'crypto', memberId: MARIA })
    expect(after.balances.at(-1)).toEqual({ on: '2026-09-23', amount: 3150.4 })
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(legacy.updatedAt))
    expect(message).toBe('Checked in “Coinbase”')
  })

  it('holding crypto, is marked with a gold ₿ coin wherever it shows, and the other kinds keep their emoji', () => {
    const coinbase = account('cb', 'Coinbase', 'investment', ['2026-09-23', 3150.4], { holding: 'crypto' })
    render(<Finance {...props({ accounts: [...accounts, coinbase] })} />)
    const coin = (el: Element | null | undefined) => el?.querySelector('.fin-coin')?.textContent
    // the strip, then its sheet: the title, and the kinds
    const chip = screen.getByRole('button', { name: /^Coinbase:/ })
    expect(coin(chip)).toBe('₿')
    expect(chip.textContent).not.toContain('🪙')
    fireEvent.click(chip)
    expect(within(dialog()).getByRole('heading', { name: '₿ Coinbase' })).toBeTruthy()
    const kinds = within(dialog()).getByRole('radiogroup', { name: 'Kind of account' })
    expect(coin(within(kinds).getByRole('radio', { name: 'Crypto' }))).toBe('₿')
    expect(within(kinds).getByRole('radio', { name: 'Stocks & funds' }).textContent).toBe('📈Stocks & funds')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    // Check in's rows
    fireEvent.click(within(card('Safe to spend')).getByRole('button', { name: 'Check in' }))
    expect(coin(within(dialog()).getByLabelText('Coinbase: balance today').closest('li'))).toBe('₿')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    // and Manage's list
    manage('Accounts')
    expect(coin(within(screen.getByRole('region', { name: 'Investments' })).getByRole('listitem'))).toBe('₿')
  })

  it('becomes another type altogether, and leaves its holding behind', () => {
    const coinbase = account('cb', 'Coinbase', 'investment', ['2026-09-23', 3150.4], { holding: 'crypto' })
    const p = props({ accounts: [...accounts, coinbase] })
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Coinbase:/ }))
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Savings' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))
    const [, after, message] = vi.mocked(p.onChangeAccount).mock.calls[0]
    expect(after).toMatchObject({ type: 'savings', name: 'Coinbase' })
    expect(after).not.toHaveProperty('holding')
    expect(message).toBe('Saved “Coinbase”')
  })

  it('is archived and deleted from its sheet', () => {
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Amex:/ }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Archive' }))
    const [before, after, message] = vi.mocked(p.onChangeAccount).mock.calls[0]
    expect(before).toBe(accounts[1])
    expect(after.archivedAt).toBeTruthy()
    expect(message).toBe('Archived “Amex”')
    fireEvent.click(screen.getByRole('button', { name: /^Amex:/ }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete it?' }))
    expect(p.onRemoveAccount).toHaveBeenCalledWith('amex')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Check in', () => {
  it('writes every account typed into at once, a card as what is owed, and ticks off the week’s check-in', () => {
    const checkIn = task(`${CHECK_IN_PREFIX}me`, { title: 'Check in your balances', recurrence: { freq: 'weekly' }, dueAt: day(9, 27, 18), ownerId: JOSEPH })
    const p = props({ tasks: [...rows, checkIn] })
    render(<Finance {...p} />)
    fireEvent.click(within(card('Safe to spend')).getByRole('button', { name: 'Check in' }))
    const sheet = dialog()
    const inputs = within(sheet).getAllByRole('textbox')
    for (const input of inputs) {
      expect(input.getAttribute('inputmode')).toBe('decimal')
      expect(input.className).toContain('fin-amount-input')
    }
    fireEvent.change(within(sheet).getByLabelText('Joint checking: balance today'), { target: { value: '$1,502.33' } })
    fireEvent.change(within(sheet).getByLabelText('Amex: owed today'), { target: { value: '-700' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }))
    expect(p.onCheckIn).toHaveBeenCalledTimes(1)
    const [changes, done] = vi.mocked(p.onCheckIn).mock.calls[0]
    expect(changes.map(c => [c.after.name, c.after.balances.at(-1)])).toEqual([
      ['Joint checking', { on: '2026-09-23', amount: 1502.33 }],
      ['Amex', { on: '2026-09-23', amount: 700 }],
    ])
    expect(changes.every(c => c.before !== null && Date.parse(c.after.updatedAt) > Date.parse(c.before.updatedAt))).toBe(true)
    // Sunday's check-in, done on the Wednesday before it, is not this one
    expect(done).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('adds an account by its kind and a name, and its balance in the same go, and will not save what is not an amount', () => {
    const p = props({ accounts: [] })
    render(<Finance {...p} />)
    fireEvent.click(within(card('Safe to spend')).getByRole('button', { name: 'Check in' }))
    const sheet = dialog()
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Savings' }))
    const add = within(sheet).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect((within(sheet).getByLabelText('Account name') as HTMLInputElement).placeholder).toBe('Name, e.g. Ally savings')
    fireEvent.change(within(sheet).getByLabelText('Account name'), { target: { value: 'Rainy day' } })
    fireEvent.click(add)
    const save = within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    fireEvent.change(within(sheet).getByLabelText('Rainy day: balance today'), { target: { value: 'lots' } })
    expect(save.disabled).toBe(true)
    expect(within(sheet).getByText('That is not an amount.')).toBeTruthy()
    fireEvent.change(within(sheet).getByLabelText('Rainy day: balance today'), { target: { value: '800' } })
    fireEvent.click(save)
    const [changes] = vi.mocked(p.onCheckIn).mock.calls[0]
    expect(changes).toHaveLength(1)
    expect(changes[0].before).toBeNull()
    expect(changes[0].after).toMatchObject({ kind: 'account', name: 'Rainy day', type: 'savings', balances: [{ on: '2026-09-23', amount: 800 }] })
  })

  it('opens from the check-in’s own task, whether Finance was on screen or not', () => {
    const opened = vi.fn()
    const view = render(<Finance {...props({ checkIn: true, onCheckInOpened: opened })} />)
    expect(within(dialog()).getByRole('heading', { name: 'Check in' })).toBeTruthy()
    expect(opened).toHaveBeenCalled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // handed over again while Finance is up
    view.rerender(<Finance {...props({ checkIn: false, onCheckInOpened: opened })} />)
    view.rerender(<Finance {...props({ checkIn: true, onCheckInOpened: opened })} />)
    expect(within(dialog()).getByRole('heading', { name: 'Check in' })).toBeTruthy()
  })
})

describe('the palette’s New bill', () => {
  it('opens + Bill’s own sheet, with its templates, whether Finance was on screen or not', () => {
    const opened = vi.fn()
    const view = render(<Finance {...props({ addBill: true, onAddBillOpened: opened })} />)
    expect(within(dialog()).getByRole('heading', { name: 'Add a bill' })).toBeTruthy()
    expect(within(dialog()).getByRole('button', { name: 'Rent' })).toBeTruthy()
    expect(opened).toHaveBeenCalled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // handed over again while Finance is up
    view.rerender(<Finance {...props({ addBill: false, onAddBillOpened: opened })} />)
    view.rerender(<Finance {...props({ addBill: true, onAddBillOpened: opened })} />)
    expect(within(dialog()).getByRole('heading', { name: 'Add a bill' })).toBeTruthy()
  })
})

describe('the weekly check-in', () => {
  it('turns on in Manage as a weekly task on Sunday at six, moves, and turns off', () => {
    const p = props()
    const view = render(<Finance {...p} />)
    manage('Accounts')
    fireEvent.click(screen.getByLabelText('Check in weekly'))
    const [added, message] = vi.mocked(p.onAdd).mock.calls[0]
    expect(added.id.startsWith(CHECK_IN_PREFIX)).toBe(true)
    expect(added).toMatchObject({ title: 'Check in your balances', recurrence: { freq: 'weekly' }, shared: false })
    expect(added.dueAt).toBe(new Date(2026, 8, 27, 18, 0).toISOString())
    expect(message).toMatch(/^Check in weekly: Sundays at 6:00\sPM$/)

    const on = { ...added, ownerId: JOSEPH }
    view.rerender(<Finance {...props({ ...p, tasks: [...rows, on] })} />)
    expect((screen.getByLabelText('Check in weekly') as HTMLInputElement).checked).toBe(true)
    fireEvent.change(screen.getByLabelText('Check-in day'), { target: { value: '5' } })
    expect(vi.mocked(p.onSaveTask).mock.calls[0][0]).toMatchObject({ id: on.id, dueAt: new Date(2026, 8, 25, 18, 0).toISOString() })
    fireEvent.click(screen.getByLabelText('Check in weekly'))
    expect(p.onRemoveTask).toHaveBeenCalledWith(on)
  })
})

describe('+ Goal', () => {
  it('saves towards something with a set-aside that repeats, and says what it will come to', () => {
    const p = props()
    render(<Finance {...p} />)
    plus('Goal')
    const sheet = dialog()
    fireEvent.click(within(sheet).getByRole('radio', { name: '✈️' }))
    fireEvent.change(within(sheet).getByLabelText('Goal name'), { target: { value: 'Lisbon' } })
    fireEvent.change(within(sheet).getByLabelText('Target'), { target: { value: '1,200' } })
    fireEvent.change(within(sheet).getByLabelText('Set aside'), { target: { value: '100' } })
    fireEvent.change(within(sheet).getByLabelText('By (optional)'), { target: { value: '2026-12-31' } })
    expect(within(sheet).getByText(/^4 set-asides by Dec 31 come to \$400\.00 — \$300\.00 each would reach \$1,200\.00\.$/)).toBeTruthy()
    fireEvent.change(within(sheet).getByLabelText('How often'), { target: { value: 'weekly' } })
    expect(within(sheet).getByText(/^15 set-asides by Dec 31 reach \$1,200\.00\.$/)).toBeTruthy()
    act(() => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    })
    const [goal, message] = vi.mocked(p.onAdd).mock.calls[0]
    expect(goal).toMatchObject({ title: 'Lisbon', estimateCost: 100, recurrence: { freq: 'weekly' }, bill: { kind: 'saving', emoji: '✈️', goal: { target: 1200, by: '2026-12-31' } }, shared: true })
    expect(goal.dueAt).toBe(new Date(2026, 8, 23).toISOString())
    expect(message).toBe('Saving for “Lisbon”')
  })
})
