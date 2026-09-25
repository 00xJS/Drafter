import type { Page } from '@playwright/test'
import { expect, test, type App } from './fixtures'

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
  // alone on this planner, there is nobody else's log to count
  await expect(page.getByRole('group', { name: 'Whose log' })).toHaveCount(0)

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
