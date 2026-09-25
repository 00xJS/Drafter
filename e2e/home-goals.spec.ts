import type { Page } from '@playwright/test'
import { expect, inLocalCopy, test } from './fixtures'

// Home's top section: this week's 3 set on Home with none set, ticked there
// and kept across a reload, the cheer on all 3, and the week strip's way to
// a day on the Calendar.

/** An empty planner's Home is one welcome card: a task filed from the palette draws the day. */
async function fileATask(page: Page) {
  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByRole('dialog', { name: 'Search' })
  await palette.getByRole('combobox', { name: 'Search' }).fill('Water the plants tomorrow at 9am')
  await palette.getByRole('combobox', { name: 'Search' }).press('Shift+Enter')
  await expect(palette).toBeHidden()
}

test('this week’s 3 are set on Home, ticked there, kept, and cheered when all 3 are done', async ({ page, app }) => {
  await app.open()
  await fileATask(page)

  const ask = page.getByRole('region', { name: 'Set this week’s 3' })
  await expect(ask.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await ask.getByRole('textbox', { name: 'Goal 1' }).fill('Book the electrician')
  await ask.getByRole('textbox', { name: 'Goal 2' }).fill('Finish the garage shelves')
  await ask.getByRole('textbox', { name: 'Goal 3' }).fill('Date night Friday')
  await ask.getByRole('button', { name: 'Save', exact: true }).click()

  const goals = page.getByRole('region', { name: 'This week’s 3' })
  await expect(goals.getByRole('img', { name: '0 of 3 done' })).toBeVisible()
  await goals.getByRole('checkbox', { name: 'Mark “Book the electrician” done' }).check()
  await expect(goals.getByRole('img', { name: '1 of 3 done' })).toBeVisible()
  await expect.poll(() => inLocalCopy(page, 'Date night Friday')).toBe(true)
  await expect.poll(() => inLocalCopy(page, '"topDone":[true,false,false]')).toBe(true)

  // kept: the same three, the same tick, after a reload
  await app.open()
  await expect(goals.getByRole('checkbox', { name: 'Mark “Book the electrician” not done' })).toBeChecked()
  await expect(goals.getByRole('checkbox', { name: 'Mark “Finish the garage shelves” done' })).not.toBeChecked()

  // the last tick says so
  await goals.getByRole('checkbox', { name: 'Mark “Finish the garage shelves” done' }).check()
  await expect(goals.getByRole('status')).toHaveText('Tick them off as the week goes')
  await goals.getByRole('checkbox', { name: 'Mark “Date night Friday” done' }).check()
  await expect(goals.getByRole('status')).toHaveText('All 3 done')
  await expect(goals.getByRole('img', { name: '3 of 3 done' })).toBeVisible()

  // …and Edit opens the same lines
  await goals.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(goals.getByRole('textbox', { name: 'Goal 2' })).toHaveValue('Finish the garage shelves')
})

test('a day of the week strip opens the Calendar on that day', async ({ page, app }) => {
  await app.open()
  await fileATask(page)
  await page.getByRole('navigation', { name: 'This week' }).getByRole('button', { name: /^Today, / }).click()
  await expect(page.getByRole('dialog', { name: app.spokenToday })).toBeVisible()
})
