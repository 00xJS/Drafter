import type { Page } from '@playwright/test'
import { expect, test, type App } from './fixtures'

/** The one line a household is told what counts whose by, under the period. */
const SCOPE_LINE = 'Tasks, money and meals count the household; people, places, your journal, habits and clothes are yours.'

/** A household of two, as this device kept it from the server's last answer (src/household.ts): local mode reads it as it is. */
const JOE = '11111111-0000-4000-8000-00000000aaaa'
const MARIA = '22222222-0000-4000-8000-00000000bbbb'
const HOUSEHOLD = {
  me: { id: JOE, email: 'joe@example.test', displayName: 'Joe' },
  household: { id: 'h1', name: 'Home', created_by: JOE },
  members: [
    { id: JOE, email: 'joe@example.test', displayName: 'Joe' },
    { id: MARIA, email: 'maria@example.test', displayName: 'Maria' },
  ],
}

/** A task filed from the palette and ticked done in its editor, as tasks.spec.ts files one. */
async function finishATask(page: Page, app: App, title: string) {
  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByRole('dialog', { name: 'Search' })
  await palette.getByRole('combobox', { name: 'Search' }).fill(title)
  await palette.getByRole('combobox', { name: 'Search' }).press('Shift+Enter')
  await expect(palette).toBeHidden()
  await app.go('Tasks')
  await page.getByRole('button', { name: title, exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByRole('button', { name: 'Done', exact: true }).click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
}

test('Insights opens on its Highlights: the week, then the month, and People’s figures from a chip and back', async ({ page, app }) => {
  await app.open()
  await finishATask(page, app, 'Water the plants')

  await app.go('Insights')
  await page.getByRole('tablist', { name: 'Insights view' }).getByRole('tab', { name: 'Stats' }).click()
  const period = page.getByRole('group', { name: 'Period' })
  await expect(period.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible()
  const highlights = page.getByRole('list', { name: /^Highlights/ })
  await expect(highlights.getByRole('button', { name: /^1 task done this week/ })).toBeVisible()
  // one view, with no switch; alone, everything counted is yours, so nothing says whose
  await expect(page.getByRole('group', { name: 'Whose log' })).toHaveCount(0)
  await expect(page.getByText(SCOPE_LINE)).toHaveCount(0)

  await period.getByRole('button', { name: 'Month', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'This month' })).toBeVisible()
  await expect(highlights.getByRole('button', { name: /^1 task done this month/ })).toBeVisible()

  // an area's figures are a page pushed over the Highlights, with ‹ Back
  await page.getByRole('navigation', { name: 'Every figure, by area' }).getByRole('button', { name: 'People', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'People', level: 2 })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Insights view' })).toHaveCount(0)
  await expect(page.getByText('Add the people you want to keep close on the List.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()

  // …and Back lands on the Highlights, still on the month
  await expect(page.getByRole('tablist', { name: 'Insights view' })).toBeVisible()
  await expect(period.getByRole('button', { name: 'Month', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: 'This month' })).toBeVisible()
})

test('in a household, Insights is one view: a line under the period says what counts whose, and nothing wears a badge', async ({ page, app }) => {
  await page.addInitScript(info => {
    if (!localStorage.getItem('drafter:household')) localStorage.setItem('drafter:household', JSON.stringify(info))
  }, HOUSEHOLD)
  await app.open()
  await finishATask(page, app, 'Take the bins out')

  await app.go('Insights')
  await page.getByRole('tablist', { name: 'Insights view' }).getByRole('tab', { name: 'Stats' }).click()
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible()
  await expect(page.getByText(SCOPE_LINE)).toBeVisible()
  // no switch to choose whose log, and no card says whose it is
  await expect(page.getByRole('group', { name: 'Whose log' })).toHaveCount(0)
  const highlights = page.getByRole('list', { name: /^Highlights/ })
  await expect(highlights.getByRole('button', { name: /^1 task done this week/ })).toBeVisible()
  await expect(highlights.getByText(/Both of us|Just you/)).toHaveCount(0)

  // …and an area's page carries none either
  await page.getByRole('navigation', { name: 'Every figure, by area' }).getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Tasks', level: 2 })).toBeVisible()
  await expect(page.getByText('Finished', { exact: true })).toBeVisible()
  await expect(page.getByText(/Both of us|Just you/)).toHaveCount(0)
})
