import type { Page } from '@playwright/test'
import { expect, inLocalCopy, test, type App } from './fixtures'

/** Keep → Wardrobe, on Outfit. */
async function openWardrobe(page: Page, app: App) {
  await app.go('Keep')
  await page.getByRole('tablist', { name: 'Keep view' }).getByRole('tab', { name: 'Wardrobe' }).click()
  await expect(page.getByRole('button', { name: 'Save outfit' })).toBeVisible()
}

/** Add clothing, on its name alone: the photo can come later. */
async function addPiece(page: Page, name: string, type: 'Top' | 'Bottom') {
  await page.getByRole('button', { name: 'Add clothing' }).click()
  const sheet = page.getByRole('dialog', { name: 'Add clothing' })
  await sheet.getByRole('radiogroup', { name: 'Type' }).getByRole('radio', { name: type, exact: true }).click()
  await sheet.getByRole('textbox', { name: 'Name' }).fill(name)
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sheet).toBeHidden()
}

async function addWardrobe(page: Page) {
  for (const [name, type] of [
    ['Navy tee', 'Top'],
    ['Linen shirt', 'Top'],
    ['Black jeans', 'Bottom'],
    ['Chinos', 'Bottom'],
  ] as const)
    await addPiece(page, name, type)
}

const week = (page: Page) => page.getByRole('group', { name: 'Days of the week' })

test('a look put together through the pickers is worn today, and the week strip dots the day', async ({ page, app }) => {
  await app.open()
  await openWardrobe(page, app)
  await addWardrobe(page)

  // a day nobody has dressed asks for each piece; nothing stands in for a choice
  await expect(page.getByRole('button', { name: 'Wearing this' })).toBeDisabled()
  await page.getByRole('button', { name: 'Add a top' }).click()
  const tops = page.getByRole('dialog', { name: 'Choose a top' })
  await tops.getByRole('button', { name: /^Navy tee/ }).click()
  await expect(tops).toBeHidden()
  await page.getByRole('button', { name: 'Add a bottom' }).click()
  await page.getByRole('dialog', { name: 'Choose a bottom' }).getByRole('button', { name: /^Chinos/ }).click()
  await expect(page.getByRole('button', { name: 'Top: Navy tee. Choose another' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bottom: Chinos. Choose another' })).toBeVisible()

  await page.getByRole('button', { name: 'Wearing this' }).click()
  await expect(page.getByRole('status')).toContainText('Logged for today')
  await expect(week(page).getByRole('button', { name: /, today: a look worn$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Update look' })).toBeVisible()
  await expect.poll(() => inLocalCopy(page, `wear~${app.today}~`)).toBe(true)
})

test('Plan the week plans each day left as one batch, rings them on the strip, and one Undo takes them back', async ({ page, app }) => {
  await app.open()
  await openWardrobe(page, app)
  await addWardrobe(page)

  // next week: every one of its days is still to come
  await page.getByRole('button', { name: 'The week after' }).click()
  await page.getByRole('button', { name: 'Plan the week' }).click()
  const sheet = page.getByRole('dialog', { name: 'Plan the week' })
  await expect(sheet.getByRole('checkbox')).toHaveCount(7)
  await sheet.getByRole('button', { name: 'Plan 7 days' }).click()
  await expect(sheet).toBeHidden()

  await expect(page.getByRole('status')).toContainText('Planned 7 days')
  await expect(week(page).getByRole('button', { name: /: a look planned$/ })).toHaveCount(7)
  await expect(page.getByRole('button', { name: 'Plan the week' })).toBeDisabled()

  await page.getByRole('status').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(week(page).getByRole('button', { name: /: a look planned$/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Plan the week' })).toBeEnabled()
})
