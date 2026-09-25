import type { Page } from '@playwright/test'
import { expect, test, type App } from './fixtures'

/** A YYYY-MM-DD day `n` days on from another. */
const plus = (key: string, n: number) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
/** A day as Finance writes it (components/finance/labels.ts), in the en-US the browser runs in: "Sun, Sep 27", and "Sep 27". */
const dayLabel = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
const shortDay = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })

/** Tasks → Finance, on its pay periods. */
async function openFinance(page: Page, app: App) {
  await app.go('Tasks')
  await page.getByRole('tablist', { name: 'Tasks view' }).getByRole('tab', { name: 'Finance' }).click()
  await expect(page.getByRole('region', { name: 'Safe to spend' })).toBeVisible()
}

/** Finance's one +, and what it adds. */
async function add(page: Page, what: 'Bill' | 'Payday' | 'Goal' | 'Check in') {
  await page.getByRole('button', { name: 'Add to Finance' }).click()
  await page
    .getByRole('dialog', { name: 'Add to Finance' })
    .getByRole('button', { name: new RegExp(`^${what}`) })
    .click()
}

/** Check in from the first run: an account picked by its kind, named, and what it holds. */
async function firstCheckIn(page: Page, balance: string) {
  await page.getByRole('region', { name: 'Safe to spend' }).getByRole('button', { name: 'Check in' }).click()
  const checkIn = page.getByRole('dialog', { name: 'Check in' })
  await checkIn.getByRole('radio', { name: 'Checking' }).click()
  await expect(checkIn.getByRole('button', { name: 'Add', exact: true })).toBeDisabled()
  await checkIn.getByRole('textbox', { name: 'Account name' }).fill('Joint checking')
  await checkIn.getByRole('button', { name: 'Add', exact: true }).click()
  await checkIn.getByRole('textbox', { name: 'Joint checking: balance today' }).fill(balance)
  await checkIn.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(checkIn).toBeHidden()
}

test('the pay periods, from nothing: a check-in, a bill, a payday, a paid bill and a goal', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  const hero = page.getByRole('region', { name: 'Safe to spend' })
  // Finance opens on what is safe to spend, not on the line about tasks
  await expect(page.getByText('The day is on Home.')).toHaveCount(0)

  // the first run: no number until a balance is typed in
  await firstCheckIn(page, '2,000')
  await expect(page.getByRole('status')).toContainText('Checked in 1 account')
  await expect(hero).toContainText('$2,000.00')
  await expect(hero).toContainText(`Nothing falls due through ${shortDay(plus(app.today, 30))}`)

  // + Bill: rent from its template, due in three days
  await add(page, 'Bill')
  await page.getByRole('dialog', { name: 'Add a bill' }).getByRole('button', { name: 'Rent', exact: true }).click()
  const bill = page.getByRole('dialog', { name: /Rent/ })
  await bill.getByLabel('Amount due').fill('1200')
  await bill.getByLabel('Next due').fill(plus(app.today, 3))
  await bill.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(bill).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Added “Rent”')

  // + Payday: its own short form, which will not add a payday without the day of the next one
  await add(page, 'Payday')
  const payday = page.getByRole('dialog', { name: '💵 Payday' })
  await payday.getByLabel('Take-home pay').fill('1500')
  await expect(payday.getByRole('button', { name: 'Add', exact: true })).toBeDisabled()
  await expect(payday.getByRole('button', { name: 'Every 2 weeks' })).toHaveAttribute('aria-pressed', 'true')
  await payday.getByLabel('Next payday').fill(plus(app.today, 5))
  await payday.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(payday).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Added “Payday”')

  // safe to spend is the lowest the line goes: the rent's day, before the payday two days after it
  await expect(hero).toContainText('$800.00')
  await expect(hero).toContainText(`Lowest on ${dayLabel(plus(app.today, 3))}, before Payday`)
  // the rent comes before the first paycheck, so it is Now; the paycheck and the fortnight after it are cards of their own
  const now = page.getByRole('region', { name: 'Now', exact: true })
  await expect(now.getByRole('listitem')).toHaveCount(1)
  await expect(now.getByRole('listitem')).toContainText('Rent')
  await expect(now).toContainText('Left before Payday')
  await expect(now).toContainText('$800.00')
  const first = page.getByRole('region', { name: `Payday · ${dayLabel(plus(app.today, 5))}` })
  await expect(first).toContainText('+$1,500.00')
  await expect(first.getByRole('button', { name: 'Mark Payday received' })).toBeVisible()
  // …the fortnight after it is expected, with nothing to tick
  const next = page.getByRole('region', { name: `Payday · ${dayLabel(plus(app.today, 19))}` })
  await expect(next).toContainText('Expected')
  await expect(next.getByRole('button', { name: /^Mark / })).toHaveCount(0)
  // …and the line, a tap away, names its lowest point
  await hero.getByRole('button', { name: 'See the line' }).click()
  const line = page.getByRole('dialog', { name: 'Cash, next 30 days' })
  await expect(line.getByRole('button', { name: /^Spendable cash over the next 30 days/ })).toContainText('Low point $800.00')
  await line.getByRole('button', { name: 'Close' }).click()
  await expect(line).toBeHidden()

  // Paid: the rent is settled and next month's is past the 30 days shown. Paid
  // before its day and after the check-in, it still comes off on its day
  await now.getByRole('button', { name: 'Mark Rent paid' }).click()
  await expect(page.getByRole('status')).toContainText('Moved to Done')
  await expect(now).toBeHidden()
  await expect(hero).toContainText('$800.00')

  // + Goal: an emergency fund, a first set-aside today
  await add(page, 'Goal')
  const goal = page.getByRole('dialog', { name: 'New goal' })
  await goal.getByRole('textbox', { name: 'Goal name' }).fill('Emergency fund')
  await goal.getByLabel('Target').fill('1000')
  await goal.getByLabel('Set aside').fill('100')
  await expect(goal).toContainText('10 set-asides of $100.00 a month reach $1,000.00.')
  await goal.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(goal).toBeHidden()
  const goals = page.getByRole('region', { name: 'Goals' })
  await expect(goals).toContainText('$0.00 of $1,000.00')

  // the first set-aside is due today: moving it is the goal's progress
  await page.getByRole('button', { name: 'Mark Emergency fund set aside' }).click()
  await expect(goals).toContainText('$100.00 of $1,000.00')
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  await page.getByRole('tablist', { name: 'Manage' }).getByRole('tab', { name: 'Goals' }).click()
  await expect(page.getByRole('region', { name: 'Goals' })).toContainText('9 more to go')
})

test('money with no date is listed, left out, and dated where it is listed', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  const hero = page.getByRole('region', { name: 'Safe to spend' })
  await firstCheckIn(page, '1,000')

  // a payday saved from the full editor with no date, as the owner's two were
  await add(page, 'Payday')
  const payday = page.getByRole('dialog', { name: '💵 Payday' })
  await payday.getByLabel('Take-home pay').fill('900')
  await payday.getByRole('button', { name: 'More options…' }).click()
  const editor = page.getByRole('dialog', { name: 'New task' })
  await expect(editor.getByRole('textbox', { name: 'Title' })).toHaveValue('Payday')
  await expect(editor.getByText('Add a date so Finance can count it.')).toBeVisible()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()

  // not counted, and saying so; listed first, with the field that dates it
  await expect(hero).toContainText('$1,000.00')
  await expect(hero).toContainText('1 payday has no date, so it isn’t counted yet.')
  const needs = page.getByRole('region', { name: 'Needs a date' })
  await expect(needs.getByRole('listitem')).toHaveCount(1)
  await expect(needs).toContainText('+$900.00')
  await needs.getByLabel('Payday: next date').fill(plus(app.today, 2))

  // dated: counted every fortnight it lands in the 30 days, a card each
  await expect(needs).toBeHidden()
  await expect(hero).not.toContainText('no date')
  await expect(hero).toContainText('Lowest today, before Payday')
  await expect(page.getByRole('region', { name: /^Payday · / })).toHaveCount(3)
})

test('a payday dated in the full editor is counted from that day, and edited in its short sheet', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  const hero = page.getByRole('region', { name: 'Safe to spend' })
  await firstCheckIn(page, '500')

  // the editor asks money for a day alone: a date-and-time field on an iPhone could be left holding nothing
  await add(page, 'Payday')
  const payday = page.getByRole('dialog', { name: '💵 Payday' })
  await payday.getByLabel('Take-home pay').fill('1200')
  await payday.getByRole('button', { name: 'More options…' }).click()
  const editor = page.getByRole('dialog', { name: 'New task' })
  await expect(editor.getByLabel('Take-home pay')).toHaveValue('1200')
  await expect(editor.getByLabel('Arrived this time')).toHaveCount(0)
  const next = editor.getByLabel('Next payday')
  await expect(next).toHaveAttribute('type', 'date')
  await next.fill(plus(app.today, 3))
  await expect(editor.getByText('Add a date so Finance can count it.')).toBeHidden()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()

  await expect(hero).toContainText('$500.00')
  // three days out and a fortnight after; the next is past the 30 days
  await expect(hero).toContainText('Lowest today, before Payday')
  await expect(page.getByRole('region', { name: /^Payday · / })).toHaveCount(2)
  await expect(page.getByRole('region', { name: 'Needs a date' })).toHaveCount(0)

  // a tap on the paycheck opens its short sheet, not the full editor: moved two days on
  await page.getByRole('button', { name: new RegExp(`^Payday\\s*${dayLabel(plus(app.today, 3))}`) }).click()
  const sheet = page.getByRole('dialog', { name: '💵 Payday' })
  await expect(sheet.getByLabel('Take-home pay')).toHaveValue('1200.00')
  await sheet.getByLabel('Next payday').fill(plus(app.today, 5))
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('region', { name: `Payday · ${dayLabel(plus(app.today, 5))}` })).toBeVisible()

  // and its row in Manage's Paydays says when
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  await page.getByRole('tablist', { name: 'Manage' }).getByRole('tab', { name: 'Paydays' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Payday' })).toContainText(`Next: ${dayLabel(plus(app.today, 5))}`)
})

test('an account is added by its kind and its name: a Retirement account, out of safe to spend', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  const hero = page.getByRole('region', { name: 'Safe to spend' })
  await firstCheckIn(page, '1,200')
  await expect(hero).toContainText('$1,200.00')

  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  await page.getByRole('tablist', { name: 'Manage' }).getByRole('tab', { name: 'Accounts' }).click()
  await page.getByRole('button', { name: '+ Account' }).click()
  await page.getByRole('dialog', { name: 'Add an account' }).getByRole('radio', { name: 'Retirement' }).click()
  // named for its kind until it has a name of its own
  await expect(page.getByRole('dialog', { name: '🏖️ Retirement' })).toBeVisible()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toContainText('Retirement (401(k), IRA)')
  const name = sheet.getByRole('textbox', { name: 'Name' })
  await expect(name).toHaveAttribute('placeholder', 'e.g. Fidelity 401(k)')
  // never one called after its kind: no name, no Add
  await expect(sheet.getByRole('button', { name: 'Add', exact: true })).toBeDisabled()
  await name.fill('Fidelity 401(k)')
  await expect(page.getByRole('dialog', { name: '🏖️ Fidelity 401(k)' })).toBeVisible()
  await sheet.getByRole('textbox', { name: 'Balance today' }).fill('48,210.55')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Added “Fidelity 401(k)”')

  // an investment, saying what it holds, and in net worth only
  const investments = page.getByRole('region', { name: 'Investments' })
  await expect(investments.getByRole('listitem')).toContainText('Fidelity 401(k)')
  await expect(investments.getByRole('listitem')).toContainText('Retirement')
  await expect(page.getByRole('list', { name: 'Totals' })).toContainText('Net worth$49,410.55')
  await expect(page.getByRole('list', { name: 'Totals' })).toContainText('Spendable today$1,200.00')

  // back on the periods: in the strip, and not a cent of it in safe to spend
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(hero).toContainText('$1,200.00')
  await page.getByRole('button', { name: /^Fidelity 401\(k\): \$48,210\.55/ }).click()
  const account = page.getByRole('dialog', { name: /Fidelity 401\(k\)/ })
  await expect(account.getByRole('radio', { name: 'Retirement' })).toHaveAttribute('aria-checked', 'true')
  await account.getByRole('textbox', { name: 'Name' }).fill('Fidelity 401(k) — Joe')
  await account.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Saved “Fidelity 401(k) — Joe”')
  await expect(page.getByRole('button', { name: /^Fidelity 401\(k\) — Joe:/ })).toBeVisible()
})

test('the weekly check-in is a task that opens Finance’s Check in wherever it is tapped', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  await page.getByRole('tablist', { name: 'Manage' }).getByRole('tab', { name: 'Accounts' }).click()
  await page.getByRole('checkbox', { name: 'Check in weekly' }).check()
  await expect(page.getByRole('status')).toContainText('Check in weekly: Sundays at 6:00')
  await expect(page.getByRole('combobox', { name: 'Check-in day' })).toHaveValue('0')

  // on the list like any task, and tapped there, it lands on the sheet
  await page.getByRole('tablist', { name: 'Tasks view' }).getByRole('tab', { name: 'List' }).click()
  await page.getByRole('button', { name: 'Check in your balances', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Check in' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Tasks view' }).getByRole('tab', { name: 'Finance' })).toHaveAttribute('aria-selected', 'true')
})
