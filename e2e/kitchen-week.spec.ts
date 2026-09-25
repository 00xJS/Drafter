import { expect, inLocalCopy, test } from './fixtures'

// Kitchen → This week, levelled up, on a phone in the iOS look and on a
// desktop: an empty dinner planned from an idea in one tap, changed through
// the meal picker (Cook and Eat out, Leftovers first on Cook) to somewhere to
// eat out, a lunch answered with Leftovers, the last of its ideas, and a
// recipe starred for the Favourites rotation. Local mode, so no household:
// For and Who's cooking are the DOM tests' (kitchen-week.dom.test.tsx).

test('This week: an idea, the picker, Leftovers and a star', async ({ page, app }) => {
  await app.open()
  await app.go('Keep')
  await page.getByRole('tab', { name: 'Kitchen' }).click()

  // a dish to have ideas from: saved on Recipes, then done with its cook sheet
  await page.getByRole('button', { name: 'Recipes', exact: true }).click()
  await page.getByRole('button', { name: '+ Recipe' }).first().click()
  const form = page.getByRole('dialog', { name: 'New recipe' })
  await form.getByPlaceholder('e.g. Friday pizza').fill('Tacos')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('dialog', { name: 'Tacos' }).getByRole('button', { name: 'Done', exact: true }).click()

  // tonight's dinner, from the day card's ideas, in one tap
  await page.getByRole('button', { name: 'This week', exact: true }).click()
  const dinner = page.getByRole('region', { name: 'Dinner' })
  await expect(dinner).toHaveClass(/empty/)
  await dinner.getByRole('group', { name: 'Ideas for dinner' }).getByRole('button', { name: 'Tacos' }).click()
  await expect(dinner.getByText('Tacos', { exact: true })).toBeVisible()
  await expect(dinner.getByRole('button', { name: 'Start cooking' })).toBeVisible()
  // the strip's dot for it
  await expect(page.getByRole('navigation', { name: 'Dinners this week' }).locator('.week-strip-day.picked .week-strip-dots > i')).toHaveCount(1)

  // changed through the picker: Eat out, somewhere new
  await dinner.getByRole('button', { name: 'Change dinner' }).click()
  const picker = page.getByRole('dialog', { name: / · Dinner$/ })
  await expect(picker.getByRole('button', { name: /^Tacos/, pressed: true })).toBeVisible()
  // two tabs, and Leftovers on Cook, straight after Something new…
  await expect(picker.getByRole('tab')).toHaveText(['Cook', 'Eat out'])
  const cookRows = picker.getByRole('list', { name: 'Recipes' }).locator('.meal-pick-row')
  await expect(cookRows.nth(0)).toHaveText('Something new…')
  await expect(cookRows.nth(1)).toContainText('Leftovers')
  await expect(cookRows.nth(1)).toContainText('At home, nothing new to cook')
  await picker.getByRole('tab', { name: 'Eat out' }).click()
  await picker.getByRole('button', { name: 'Somewhere new…' }).click()
  await picker.getByRole('textbox', { name: `Name of the place for dinner on ${app.spokenToday}` }).fill('Luna’s Pizza')
  await picker.getByRole('radio', { name: 'Restaurant' }).click()
  await picker.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(picker).toBeHidden()
  await expect(dinner.getByText('Luna’s Pizza', { exact: true })).toBeVisible()
  await expect(dinner.getByText('Eat out')).toBeVisible()
  await expect(dinner.getByRole('button', { name: 'Start cooking' })).toHaveCount(0)

  // lunch: Leftovers, one tap, the last of its ideas
  const lunch = page.getByRole('region', { name: 'Lunch' })
  const lunchIdeas = lunch.getByRole('group', { name: 'Ideas for lunch' }).getByRole('button')
  await expect(lunchIdeas.last()).toHaveText('🍲 Leftovers')
  await lunchIdeas.last().click()
  await expect(lunch.getByText('Leftovers', { exact: true })).toBeVisible()
  await expect(lunch.getByText('Nothing to cook')).toBeVisible()

  // and a star on the recipe, for the rotation
  await page.getByRole('button', { name: 'Recipes', exact: true }).click()
  const star = page.getByRole('button', { name: 'Favourite: Tacos' })
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'true')

  // all of it kept on the device, and there after a reopen
  await expect.poll(() => inLocalCopy(page, '"favourite":true')).toBe(true)
  await expect.poll(() => inLocalCopy(page, '"quick":"leftovers"')).toBe(true)
  await app.open()
  await app.go('Keep')
  await page.getByRole('tab', { name: 'Kitchen' }).click()
  await page.getByRole('button', { name: 'This week', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Dinner' }).getByText('Luna’s Pizza', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Lunch' }).getByText('Leftovers', { exact: true })).toBeVisible()
})
