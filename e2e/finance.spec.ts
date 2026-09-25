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

/** Tasks → Finance, on its timeline. */
async function openFinance(page: Page, app: App) {
  await app.go('Tasks')
  await page.getByRole('tablist', { name: 'Tasks view' }).getByRole('tab', { name: 'Finance' }).click()
  await expect(page.getByRole('tablist', { name: 'Finance view' }).getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true')
}

test('the money timeline, from nothing: a check-in, a bill, a payday, a paid bill and a goal', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  const hero = page.getByRole('region', { name: 'Safe to spend' })

  // the first run: no number until a balance is typed in
  await hero.getByRole('button', { name: 'Check in' }).click()
  const checkIn = page.getByRole('dialog', { name: 'Check in' })
  await checkIn.getByRole('textbox', { name: 'Account name' }).fill('Joint checking')
  await checkIn.getByRole('button', { name: 'Add', exact: true }).click()
  await checkIn.getByRole('textbox', { name: 'Joint checking: balance today' }).fill('2,000')
  await checkIn.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(checkIn).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Checked in 1 account')
  await expect(hero).toContainText('$2,000.00')
  await expect(hero).toContainText(`Nothing falls due through ${shortDay(plus(app.today, 30))}`)

  // + Bill: rent from its template, due in three days
  await page.getByRole('group', { name: 'Add to Finance' }).getByRole('button', { name: '+ Bill' }).click()
  await page.getByRole('dialog', { name: 'Add a bill' }).getByRole('button', { name: 'Rent', exact: true }).click()
  const bill = page.getByRole('dialog', { name: /Rent/ })
  await bill.getByLabel('Amount').fill('1200')
  await bill.getByLabel('Next due').fill(plus(app.today, 3))
  await bill.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(bill).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Added “Rent”')

  // + Payday: its own short form, which will not add a payday without the day of the next one
  await page.getByRole('group', { name: 'Add to Finance' }).getByRole('button', { name: '+ Payday' }).click()
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
  await expect(hero).toContainText(`Lowest on ${dayLabel(plus(app.today, 3))}, before Payday · counts 1 bill and 2 paydays through ${shortDay(plus(app.today, 30))}`)
  const coming = page.getByRole('region', { name: 'Coming up' })
  await expect(coming.getByRole('listitem')).toHaveCount(3)
  await expect(coming.getByRole('listitem').nth(0)).toContainText('Rent')
  await expect(coming.getByRole('listitem').nth(1)).toContainText('+$1,500.00')
  // …the fortnight after it is expected, with nothing to tick
  await expect(coming.getByRole('listitem').nth(2)).toContainText('Expected')
  await expect(coming.getByRole('listitem').nth(2).getByRole('button', { name: /^Mark / })).toHaveCount(0)
  // …and the line under it names its lowest point
  await expect(page.getByRole('button', { name: /^Spendable cash over the next 30 days/ })).toContainText('Low point $800.00')

  // Paid: the rent is settled and next month's is past the 30 days shown. Paid
  // before its day and after the check-in, it still comes off on its day
  await coming.getByRole('button', { name: 'Mark Rent paid' }).click()
  await expect(page.getByRole('status')).toContainText('Moved to Done')
  await expect(coming.getByRole('listitem')).toHaveCount(2)
  await expect(hero).toContainText('$800.00')

  // + Goal: an emergency fund, a first set-aside today
  await page.getByRole('group', { name: 'Add to Finance' }).getByRole('button', { name: '+ Goal' }).click()
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
  await coming.getByRole('button', { name: 'Mark Emergency fund set aside' }).click()
  await expect(goals).toContainText('$100.00 of $1,000.00')
  await expect(goals).toContainText('9 more to go')
})

test('money with no date is listed, left out, and dated where it is listed', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  const hero = page.getByRole('region', { name: 'Safe to spend' })
  await hero.getByRole('button', { name: 'Check in' }).click()
  const checkIn = page.getByRole('dialog', { name: 'Check in' })
  await checkIn.getByRole('textbox', { name: 'Account name' }).fill('Joint checking')
  await checkIn.getByRole('button', { name: 'Add', exact: true }).click()
  await checkIn.getByRole('textbox', { name: 'Joint checking: balance today' }).fill('1,000')
  await checkIn.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(checkIn).toBeHidden()

  // a payday saved from the full editor with no date, as the owner's two were
  await page.getByRole('group', { name: 'Add to Finance' }).getByRole('button', { name: '+ Payday' }).click()
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
  const needs = page.getByRole('region', { name: 'Coming up' }).getByRole('group', { name: 'Needs a date' })
  await expect(needs.getByRole('listitem')).toHaveCount(1)
  await expect(needs).toContainText('+$900.00')
  await needs.getByLabel('Payday: next date').fill(plus(app.today, 2))

  // dated: counted every fortnight it lands in the 30 days
  await expect(needs).toBeHidden()
  await expect(hero).not.toContainText('no date')
  await expect(hero).toContainText(`Lowest today, before Payday · counts 3 paydays through ${shortDay(plus(app.today, 30))}`)
  await expect(page.getByRole('region', { name: 'Coming up' }).getByRole('listitem')).toHaveCount(3)
})

test('a payday dated in the full editor is counted from that day', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  const hero = page.getByRole('region', { name: 'Safe to spend' })
  await hero.getByRole('button', { name: 'Check in' }).click()
  const checkIn = page.getByRole('dialog', { name: 'Check in' })
  await checkIn.getByRole('textbox', { name: 'Account name' }).fill('Joint checking')
  await checkIn.getByRole('button', { name: 'Add', exact: true }).click()
  await checkIn.getByRole('textbox', { name: 'Joint checking: balance today' }).fill('500')
  await checkIn.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(checkIn).toBeHidden()

  // the editor asks money for a day alone: a date-and-time field on an iPhone could be left holding nothing
  await page.getByRole('group', { name: 'Add to Finance' }).getByRole('button', { name: '+ Payday' }).click()
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
  await expect(hero).toContainText(`Lowest today, before Payday · counts 2 paydays through ${shortDay(plus(app.today, 30))}`)
  await expect(page.getByRole('region', { name: 'Coming up' }).getByRole('group', { name: 'Needs a date' })).toHaveCount(0)
  // and its row in Paydays says when
  await page.getByRole('tablist', { name: 'Finance view' }).getByRole('tab', { name: 'Paydays' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Payday' })).toContainText(`Next: ${dayLabel(plus(app.today, 3))}`)
})

test('the weekly check-in is a task that opens Finance’s Check in wherever it is tapped', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  await page.getByRole('checkbox', { name: 'Check in weekly' }).check()
  await expect(page.getByRole('status')).toContainText('Check in weekly: Sundays at 6:00')
  await expect(page.getByRole('combobox', { name: 'Check-in day' })).toHaveValue('0')

  // on the list like any task, and tapped there, it lands on the sheet
  await page.getByRole('tablist', { name: 'Tasks view' }).getByRole('tab', { name: 'List' }).click()
  await page.getByRole('button', { name: 'Check in your balances', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Check in' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Tasks view' }).getByRole('tab', { name: 'Finance' })).toHaveAttribute('aria-selected', 'true')
})
