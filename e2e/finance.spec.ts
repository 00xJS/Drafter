import type { Page } from '@playwright/test'
import { expect, test, type App } from './fixtures'

/** A YYYY-MM-DD day `n` days on from another. */
const plus = (key: string, n: number) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Tasks → Finance, on its timeline. */
async function openFinance(page: Page, app: App) {
  await app.go('Tasks')
  await page.getByRole('tablist', { name: 'Tasks view' }).getByRole('tab', { name: 'Finance' }).click()
  await expect(page.getByRole('tablist', { name: 'Finance view' }).getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true')
}

test('the money timeline, from nothing: a check-in, a bill, a payday, a paid bill and a goal', async ({ page, app }) => {
  await app.open()
  await openFinance(page, app)
  const hero = page.getByRole('region', { name: /^Safe to spend/ })

  // the first run: no number until a balance is typed in
  await hero.getByRole('button', { name: 'Check in' }).click()
  const checkIn = page.getByRole('dialog', { name: 'Check in' })
  await checkIn.getByRole('textbox', { name: 'Account name' }).fill('Joint checking')
  await checkIn.getByRole('button', { name: 'Add', exact: true }).click()
  await checkIn.getByRole('textbox', { name: 'Joint checking: balance today' }).fill('2,000')
  await checkIn.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(checkIn).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Checked in 1 account')
  await expect(hero).toContainText('Safe to spend · next 30 days')
  await expect(hero).toContainText('$2,000.00')

  // + Bill: rent from its template, due in three days
  await page.getByRole('group', { name: 'Add to Finance' }).getByRole('button', { name: '+ Bill' }).click()
  await page.getByRole('dialog', { name: 'Add a bill' }).getByRole('button', { name: 'Rent', exact: true }).click()
  const bill = page.getByRole('dialog', { name: /Rent/ })
  await bill.getByLabel('Amount').fill('1200')
  await bill.getByLabel('Next due').fill(plus(app.today, 3))
  await bill.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(bill).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Added “Rent”')

  // + Payday: the full editor, on a payday two days after the rent
  await page.getByRole('group', { name: 'Add to Finance' }).getByRole('button', { name: '+ Payday' }).click()
  const editor = page.getByRole('dialog', { name: 'New task' })
  await expect(editor.getByRole('textbox', { name: 'Title' })).toHaveValue('Payday')
  await editor.getByLabel('Amount paid in').fill('1500')
  // the Due field's label holds its chips too (Today 18:00, Tomorrow 09:00…)
  await editor.getByRole('textbox', { name: /^Due/ }).fill(`${plus(app.today, 5)}T09:00`)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()

  // safe to spend runs to the payday now, after the rent
  await expect(hero).toContainText('Safe to spend until payday')
  await expect(hero).toContainText('$800.00')
  await expect(hero).toContainText('after 1 bill ($1,200.00)')
  const coming = page.getByRole('region', { name: 'Coming up' })
  await expect(coming.getByRole('listitem')).toHaveCount(2)
  await expect(coming.getByRole('listitem').nth(0)).toContainText('Rent')
  await expect(coming.getByRole('listitem').nth(1)).toContainText('+$1,500.00')
  // …and the line under it names its lowest point
  await expect(page.getByRole('button', { name: /^Spendable cash over the next 30 days/ })).toContainText('Low point $800.00')

  // Paid: the rent is settled and next month's is past the 30 days shown
  await coming.getByRole('button', { name: 'Mark Rent paid' }).click()
  await expect(page.getByRole('status')).toContainText('Moved to Done')
  await expect(coming.getByRole('listitem')).toHaveCount(1)

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
