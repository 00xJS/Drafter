import { expect, test } from './fixtures'

// Home stays mounted for days on the phone: iOS resumes the same page rather
// than reloading it. The React Compiler caches what a render works out from
// nothing that changes, so a date read with `new Date()` as Home rendered was
// the date Home was first drawn on — its heading, its sections and every due
// badge stayed on the day the app was opened. vitest runs the components as
// written; only the built app, here, runs what the compiler made of them.
//
// Playwright's clock stands in for the phone's: Home is opened ten minutes
// before midnight in Phoenix (the config's zone, UTC-7 all year) and carried
// past it with no reload, firing the timers that came due on the way, as a
// phone woken at 00:01 does.

/** Tuesday 22 September 2026, 23:50 in Phoenix. */
const BEFORE = new Date('2026-09-23T06:50:00Z')
/** Wednesday 23 September, 00:01 in Phoenix. */
const AFTER = Date.parse('2026-09-23T07:01:00Z')

test('Home turns the day at midnight: its heading, its sections and its badges, without a reload', async ({ page, app }) => {
  await page.clock.install({ time: BEFORE })
  await app.open()

  // two days with no time, from the editor (00:00 is a day, not a deadline)…
  const file = async (title: string, due: string) => {
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'New task' })
    await editor.getByPlaceholder('e.g. Book the electrician').fill(title)
    await editor.locator('input[type="datetime-local"]').fill(due)
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toBeHidden()
  }
  await file('Water the plants', '2026-09-22T00:00')
  await file('Book the dentist', '2026-09-23T00:00')
  // …and 9 this morning, long gone by, from the palette
  await page.keyboard.press('ControlOrMeta+K')
  const line = page.getByRole('dialog', { name: 'Search' }).getByRole('combobox', { name: 'Search' })
  await line.fill('Pay the water bill today')
  await line.press('Shift+Enter')
  await expect(page.getByRole('status')).toContainText('Captured — due')

  const heading = page.locator('.today-head .chart-sub')
  const overdue = page.locator('#today-overdue')
  const today = page.locator('#today-today')
  const row = (title: string) => page.locator('.trow').filter({ hasText: title })

  await expect(heading).toHaveText('Tuesday, September 22')
  await expect(overdue).toHaveCount(0)
  await expect(today.locator('.trow')).toHaveCount(2)
  await expect(row('Water the plants').locator('.due')).toHaveText('Today')
  await expect(row('Pay the water bill').locator('.due')).toHaveText('Was 9:00 AM')
  // tomorrow's is not on Home's lists yet
  await expect(row('Book the dentist')).toHaveCount(0)

  await page.clock.fastForward(AFTER - (await page.evaluate(() => Date.now())))

  await expect(heading).toHaveText('Wednesday, September 23')
  // yesterday's two are overdue now, the one with no time only from midnight…
  await expect(overdue.locator('.trow')).toHaveCount(2)
  await expect(overdue.locator('.trow').filter({ hasText: 'Water the plants' }).locator('.due')).toHaveText('Overdue 1d')
  await expect(overdue.locator('.trow').filter({ hasText: 'Pay the water bill' }).locator('.due')).toHaveText('Overdue 1d')
  // …and the day that has just begun is today's, all of it, and overdue nowhere
  await expect(today.locator('.trow')).toHaveCount(1)
  await expect(today.locator('.trow').filter({ hasText: 'Book the dentist' }).locator('.due')).toHaveText('Today')
})
