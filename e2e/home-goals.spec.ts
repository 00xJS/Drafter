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
  await expect(goals.getByText('Tick them off as the week goes', { exact: true })).toBeVisible()
  await goals.getByRole('checkbox', { name: 'Mark “Date night Friday” done' }).check()
  await expect(goals.getByText('All 3 done', { exact: true })).toBeVisible()
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

test('a long goal and a long habit stay inside their cards, and the habit’s targets are 44pt', async ({ page, app }) => {
  await app.open()
  await fileATask(page)
  const width = page.viewportSize()!.width
  /** A box's right edge, and the card it must stay inside. */
  const inside = async (inner: { boundingBox(): Promise<{ x: number; width: number } | null> }, outer: { boundingBox(): Promise<{ x: number; width: number } | null> }) => {
    const [a, b] = [await inner.boundingBox(), await outer.boundingBox()]
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + b!.width + 0.5)
    expect(b!.x + b!.width).toBeLessThanOrEqual(width + 0.5)
  }

  const ask = page.getByRole('region', { name: 'Set this week’s 3' })
  await ask.getByRole('textbox', { name: 'Goal 1' }).fill('Plan Grandma Rosalind’s ninetieth birthday party at the lake house in October')
  await ask.getByRole('button', { name: 'Save', exact: true }).click()
  const goals = page.getByRole('region', { name: 'This week’s 3' })
  await inside(goals.getByRole('button', { name: /^Make “Plan Grandma/ }), goals)
  await inside(goals.getByText(/^Plan Grandma/), goals)

  const habits = page.locator('.habits-card')
  await habits.getByRole('button', { name: '+ Add', exact: true }).click()
  await habits.getByRole('textbox', { name: 'Habit name' }).fill('Drink eight glasses of water through the day, every day')
  await habits.getByRole('button', { name: 'Add habit', exact: true }).click()
  const name = habits.getByRole('button', { name: /^Drink eight glasses/ })
  await inside(name, habits)
  const tick = habits.getByRole('button', { name: /^Mark Drink eight glasses/ })
  // the ring is drawn 26px; what a finger can hit is 44pt all round it (asked of the page where it is on screen)
  await tick.scrollIntoViewIfNeeded()
  const hit = await tick.evaluate(el => {
    const r = el.getBoundingClientRect()
    const around = [
      [r.left + r.width / 2, r.top - 8],
      [r.left + r.width / 2, r.bottom + 8],
      [r.left - 8, r.top + r.height / 2],
      [r.right + 8, r.top + r.height / 2],
    ]
    return around.every(([x, y]) => el.contains(document.elementFromPoint(x, y)))
  })
  expect(hit).toBe(true)
  expect((await name.boundingBox())!.height).toBeGreaterThanOrEqual(44)
})
