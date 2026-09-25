// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Finance } from '../components/Finance'
import { CHECK_IN_PREFIX } from '../../shared/domain.mts'
import { withBalance } from '../finance'
import type { Account, Task } from '../types'

// Finance as it is drawn — by the React Compiler, as every DOM test runs it:
// the timeline on its first run and filled in, money with no date, + Bill's
// templates, + Payday, Check in, + Goal, the weekly check-in, and the hand-off
// that opens Check in from the check-in's own task.

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
const account = (id: string, name: string, type: Account['type'], balance?: [string, number]): Account => {
  const a: Account = { kind: 'account', id, name, type, balances: [], createdAt: STAMP, updatedAt: STAMP }
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
  onSaveAccount: vi.fn(),
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

describe('the timeline, on its first run', () => {
  it('asks for a check-in instead of a number, and says what each empty part is for', () => {
    render(<Finance {...props({ tasks: [], accounts: [] })} />)
    expect(screen.getByRole('tab', { name: 'Timeline', selected: true })).toBeTruthy()
    const hero = screen.getByRole('region', { name: 'Safe to spend' })
    expect(within(hero).getByRole('button', { name: 'Check in' })).toBeTruthy()
    expect(hero.textContent).not.toMatch(/\$/)
    expect(screen.getByText(/Nothing due in the next 30 days/)).toBeTruthy()
    expect(screen.getByText(/No accounts yet/)).toBeTruthy()
    expect(screen.getByText(/Saving for something\?/)).toBeTruthy()
    // no line to draw with nothing to start it from
    expect(screen.queryByRole('region', { name: /Cash, next/ })).toBeNull()
  })
})

describe('the timeline, filled in', () => {
  it('says what is safe to spend: the lowest the next 30 days go, the day, and what it counted', () => {
    render(<Finance {...props()} />)
    const hero = screen.getByRole('region', { name: 'Safe to spend' })
    // 1,420.18 in checking, less the internet due since the check-in and Thursday's Netflix, before Friday's pay
    expect(hero.textContent).toContain('$1,324.70')
    expect(hero.textContent).toContain('Lowest on Thu, Sep 24, before Joseph’s pay · counts 4 bills, 4 paydays and 2 set-asides through Oct 23')
    expect(hero.className).not.toContain('short')
    // as old as the checking it counts: the card's older check-in (Sep 14) is not in the figure
    expect(hero.textContent).toContain('Balances as of Sep 21')
    expect(hero.textContent).not.toMatch(/no date/)
  })

  it('says so, in the shortfall ink, when the lowest day is below zero', () => {
    render(<Finance {...props({ accounts: [account('chk', 'Joint checking', 'checking', ['2026-09-21', 50])] })} />)
    const hero = screen.getByRole('region', { name: 'Safe to spend' })
    expect(hero.className).toContain('short')
    // 50 less the internet since the check-in and Thursday's Netflix, before Friday's pay
    expect(hero.textContent).toContain('-$45.48')
    expect(hero.textContent).toContain('Lowest on Thu, Sep 24, before Joseph’s pay')
    // and the line says when it first goes under, in the words it always has: today, with the internet out
    expect(screen.getByText(/^On Wed, Sep 23 the money you can actually spend goes to -\$29\.99 — counting only what is written down\.$/)).toBeTruthy()
  })

  it('lists what is due, overdue first, paydays by whose they are and in with a plus', () => {
    render(<Finance {...props()} />)
    const coming = screen.getByRole('region', { name: 'Coming up' })
    const items = within(coming).getAllByRole('listitem')
    const real = items.filter(li => !li.className.includes('projected'))
    const names = (lis: HTMLElement[]) => lis.map(li => li.querySelector('.bill-copy strong')?.textContent?.replace(/^\S+\s/, ''))
    expect(names(real)).toEqual(['Internet', 'Netflix', 'Joseph’s pay', 'Emergency fund', 'Rent', 'Maria’s pay'])
    const first = items[0]
    expect(first.className).toContain('overdue')
    expect(first.textContent).toContain('Overdue')
    expect(first.textContent).toContain('Autopay')
    expect(items[2].textContent).toContain('+$2,450.00')
  })

  it('lists what the repeats bring as expected, lighter and with nothing to tick', () => {
    render(<Finance {...props()} />)
    const coming = screen.getByRole('region', { name: 'Coming up' })
    const expected = within(coming)
      .getAllByRole('listitem')
      .filter(li => li.className.includes('projected'))
    // Joseph's pay every fortnight, the fund's next set-aside, next month's internet
    expect(expected.map(li => [li.querySelector('.fin-date')?.textContent, li.querySelector('.bill-copy strong')?.textContent?.replace(/^\S+\s/, '')])).toEqual([
      ['Fri 9', 'Joseph’s pay'],
      ['Sat 10', 'Emergency fund'],
      ['Thu 22', 'Internet'],
      ['Fri 23', 'Joseph’s pay'],
    ])
    for (const li of expected) {
      expect(li.textContent).toContain('Expected')
      expect(within(li).queryByRole('button', { name: /^Mark / })).toBeNull()
    }
    // only the open one can be marked received
    expect(screen.getAllByRole('button', { name: 'Mark Joseph’s pay received' })).toHaveLength(1)
  })

  it('marks a bill paid the way it always has, and opens a row in the editor', () => {
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark Netflix paid' }))
    expect(p.onMarkPaid).toHaveBeenCalledWith(rows[1])
    fireEvent.click(screen.getByRole('button', { name: 'Mark Joseph’s pay received' }))
    expect(p.onMarkPaid).toHaveBeenLastCalledWith(rows[2])
    fireEvent.click(screen.getByRole('button', { name: 'Mark Emergency fund set aside' }))
    expect(p.onMarkPaid).toHaveBeenLastCalledWith(rows[5])
    fireEvent.click(screen.getByRole('button', { name: /^Thu 24 Netflix/ }))
    expect(p.onOpen).toHaveBeenCalledWith(rows[1])
  })

  it('draws the cash line with its low point named, and looks 60 days ahead at a tap', () => {
    render(<Finance {...props()} />)
    const chart = screen.getByRole('button', { name: /^Spendable cash over the next 30 days/ })
    expect(chart.getAttribute('aria-label')).toContain('lowest $1,324.70 on Thu, Sep 24')
    expect(chart.textContent).toContain('Low point $1,324.70 · Sep 24')
    fireEvent.click(chart)
    expect(screen.getByRole('button', { name: /^Spendable cash over the next 60 days/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '60 days', pressed: true })).toBeTruthy()
  })

  it('shows the accounts as tiles, a card as owed, each opening Check in on itself', () => {
    render(<Finance {...props()} />)
    const amex = screen.getByRole('button', { name: /^Amex: \$640\.25 owed, as of Sep 14/ })
    expect(amex.querySelector('strong')?.className).toBe('owed')
    expect(screen.getByRole('button', { name: /^Joint checking: \$1,420\.18, 2d/ })).toBeTruthy()
    fireEvent.click(amex)
    expect(within(dialog()).getByRole('heading', { name: 'Check in' })).toBeTruthy()
    expect(dialog().querySelector('.checkin-row.focus')?.textContent).toContain('Amex')
  })

  it('shows a goal with what it has saved, by when, and whether it is on track', () => {
    render(<Finance {...props()} />)
    const goal = screen.getByRole('region', { name: 'Goals' })
    expect(goal.textContent).toContain('Emergency fund')
    expect(goal.textContent).toContain('$150.00 of $5,000.00 · by Jun 30')
    expect(goal.textContent).toContain('Behind')
    expect(goal.textContent).toContain('$150.00 every 2 weeks · next Sep 26')
  })

  it('keeps an average month, left over included, with what is set aside out of it', () => {
    render(<Finance {...props()} />)
    const month = document.querySelector('.fin-month')?.textContent ?? ''
    expect(month).toContain('$1,945.48 out')
    expect(month).toContain('$325.00 of it set aside')
  })

  it('keeps the month of bills, the paydays and the accounts a tap away', () => {
    render(<Finance {...props()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Bills' }))
    expect(screen.getByText('Still to pay')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Paydays' }))
    expect(screen.getByText('Money in')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Accounts' }))
    // rename, close and delete, as they were
    expect(screen.getAllByTitle('Rename')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2)
  })
})

describe('money with no date', () => {
  const bonus = task('bonus', { title: 'Payday', bill: { kind: 'income', forMemberId: MARIA }, estimateCost: 500, recurrence: { freq: 'biweekly' } })
  const gym = task('gym', { title: 'Gym', bill: { kind: 'subscription' }, estimateCost: 30, recurrence: { freq: 'monthly' } })

  it('comes first under Needs a date, is left out of safe to spend, and the figure says so', () => {
    render(<Finance {...props({ tasks: [...rows, gym, bonus] })} />)
    const coming = screen.getByRole('region', { name: 'Coming up' })
    const needs = within(coming).getByRole('group', { name: 'Needs a date' })
    expect(coming.firstElementChild?.nextElementSibling).toBe(needs)
    const items = within(needs).getAllByRole('listitem')
    expect(items.map(li => li.querySelector('.bill-copy strong')?.textContent?.replace(/^\S+\s/, ''))).toEqual(['Maria’s pay', 'Gym'])
    expect(items[0].textContent).toContain('+$500.00')
    expect(items[0].textContent).toContain('Not counted')
    const hero = screen.getByRole('region', { name: 'Safe to spend' })
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
})

describe('+ Payday', () => {
  it('will not add a payday without the date of the next one, then adds it whole', () => {
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Add to Finance' })).getByRole('button', { name: '+ Payday' }))
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
    expect(payday).toMatchObject({
      title: 'Maria’s pay',
      status: 'todo',
      estimateCost: 1980,
      recurrence: { freq: 'biweekly' },
      bill: { kind: 'income', forMemberId: MARIA },
      shared: true,
    })
    expect(payday.dueAt).toBe(new Date(2026, 9, 2).toISOString())
    expect(message).toBe('Added “Maria’s pay”')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a name typed over, takes weekly or monthly pay, and hands the rest to the full editor', () => {
    const p = props()
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Paydays' }))
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
    fireEvent.click(within(screen.getByRole('group', { name: 'Add to Finance' })).getByRole('button', { name: '+ Payday' }))
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
    fireEvent.click(screen.getByRole('button', { name: '+ Bill' }))
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
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '$142.60' } })
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

  it('hands anything the short form leaves out to the full editor, as filled in so far', () => {
    const p = props({ inHousehold: false })
    render(<Finance {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Bill' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Netflix' }))
    // alone, there is no one to share it with, and no choice to make
    expect(within(dialog()).queryByText('Who can see it')).toBeNull()
    fireEvent.change(within(dialog()).getByLabelText('Amount'), { target: { value: '15.49' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'More options…' }))
    expect(p.onNew).toHaveBeenCalledWith({ title: 'Netflix', bill: { kind: 'subscription', emoji: '🎬' }, recurrence: { freq: 'monthly' }, estimateCost: 15.49 })
  })
})

describe('Check in', () => {
  it('writes every account typed into at once, a card as what is owed, and ticks off the week’s check-in', () => {
    const checkIn = task(`${CHECK_IN_PREFIX}me`, { title: 'Check in your balances', recurrence: { freq: 'weekly' }, dueAt: day(9, 27, 18), ownerId: JOSEPH })
    const p = props({ tasks: [...rows, checkIn] })
    render(<Finance {...p} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Add to Finance' })).getByRole('button', { name: 'Check in' }))
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

  it('adds an account and its balance in the same go, and will not save what is not an amount', () => {
    const p = props({ accounts: [] })
    render(<Finance {...p} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'Safe to spend' })).getByRole('button', { name: 'Check in' }))
    const sheet = dialog()
    fireEvent.change(within(sheet).getByLabelText('Kind of account'), { target: { value: 'savings' } })
    fireEvent.change(within(sheet).getByLabelText('Account name'), { target: { value: 'Rainy day' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
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

describe('the weekly check-in', () => {
  it('turns on as a weekly task on Sunday at six, moves, and turns off', () => {
    const p = props()
    const view = render(<Finance {...p} />)
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
    fireEvent.click(within(screen.getByRole('group', { name: 'Add to Finance' })).getByRole('button', { name: '+ Goal' }))
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
