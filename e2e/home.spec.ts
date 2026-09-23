import { expect, inLocalCopy, test } from './fixtures'

test('today’s journal entry is written, and kept', async ({ page, app }) => {
  // Insights → Journal: today's editor heads the page (an empty planner's Home
  // is one welcome card, so Today's own journal card is not there yet)
  const openJournal = async () => {
    await app.go('Insights')
    await page.getByRole('tablist', { name: 'Insights view' }).getByRole('tab', { name: 'Journal' }).click()
  }
  await app.open()
  await openJournal()
  await page.getByPlaceholder('What happened, what you noticed, what you want to remember…').fill('A quiet day in the garden.')
  // it saves itself a moment after the last keystroke
  await expect(page.getByText(/^Saved \d/)).toBeVisible()
  await expect.poll(() => inLocalCopy(page, 'A quiet day in the garden.')).toBe(true)

  await app.open()
  await openJournal()
  await expect(page.getByPlaceholder('What happened, what you noticed, what you want to remember…')).toHaveValue('A quiet day in the garden.')
})

test('a rhythm set in the Rhythms sheet is still there after a reload', async ({ page, app }) => {
  await app.open()
  await app.go('Keep')
  await page.getByRole('button', { name: '+ Add person' }).click()
  const add = page.getByRole('dialog', { name: 'Add a person' })
  await add.getByPlaceholder('e.g. Mum').fill('Sam')
  await add.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(add).toBeHidden()

  await page.getByRole('button', { name: 'Rhythms', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Who, and how often' })
  await sheet.getByRole('radiogroup', { name: 'How often: Sam' }).getByRole('radio', { name: '2 weeks' }).click()
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Rhythm saved for Sam')
  await expect.poll(() => inLocalCopy(page, '"cadenceDays":14')).toBe(true)

  await app.open()
  await app.go('Keep')
  await page.getByRole('button', { name: 'Rhythms', exact: true }).click()
  await expect(page.getByRole('radiogroup', { name: 'How often: Sam' }).getByRole('radio', { name: '2 weeks' })).toBeChecked()
})

test('Settings → Appearance: Dark is still dark after a reload', async ({ page, app }) => {
  await app.open()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await app.open()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true')
})
