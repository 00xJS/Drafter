import type { Page } from '@playwright/test'
import { expect, stubAssistant, test, type App } from './fixtures'

/** Keep → Kitchen → This week: tonight's dinner as a new recipe, by name, through the meal picker. */
async function planTonight(page: Page, app: App, dish: string) {
  await app.go('Keep')
  await page.getByRole('tab', { name: 'Kitchen' }).click()
  await page.getByRole('button', { name: 'This week', exact: true }).click()
  const dinner = page.getByRole('region', { name: 'Dinner' })
  await dinner.getByRole('button', { name: 'Choose…' }).click()
  const picker = page.getByRole('dialog', { name: / · Dinner$/ })
  await picker.getByRole('button', { name: 'Something new…' }).click()
  await picker.getByRole('textbox', { name: `Name of the new recipe for dinner on ${app.spokenToday}` }).fill(dish)
  await page.keyboard.press('Enter')
  await expect(picker).toBeHidden()
  await expect(dinner.getByText(dish, { exact: true })).toBeVisible()
}

test('tonight’s dinner, planned in the Kitchen, is on Today and on the Calendar', async ({ page, app }) => {
  await app.open()
  await planTonight(page, app, 'Tacos')

  await app.go('Home')
  await expect(page.getByRole('main').getByText('Tacos').first()).toBeVisible()

  await app.go('Calendar')
  // the month's pill for it, or the day's row on a phone: either way named for the dish and the meal
  await expect(page.getByRole('main').getByText('Tacos').first()).toBeVisible()
})

test('✨ Fill in drafts a named recipe, and the week’s grocery list is built from it', async ({ page, app }) => {
  const ai = await stubAssistant(page, [
    {
      system: 'You write down how a household cooks a dish they have only named',
      reply: {
        servings: 4,
        ingredients: [
          { name: 'tortillas', qty: 8, unit: '' },
          { name: 'ground beef', qty: 1, unit: 'lb' },
          { name: 'cheddar', qty: 1, unit: 'cup' },
        ],
        steps: ['Brown the beef.', 'Warm the tortillas.', 'Fill them and top with cheese.'],
      },
    },
  ])
  await app.open()
  await planTonight(page, app, 'Tacos')

  await page.getByRole('button', { name: 'Recipes', exact: true }).click()
  await page.getByRole('listitem').filter({ hasText: 'Tacos' }).getByRole('button', { name: 'Edit', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Edit Tacos' })
  await form.getByRole('button', { name: '✨ Fill in ingredients & steps' }).click()
  await expect(form).toContainText('Drafted 3 ingredients and 3 steps')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form).toBeHidden()
  expect(ai.asked).toEqual(['You write down how a household cooks a dish they have only named'])
  // saving lands on the recipe itself; done with it
  const recipe = page.getByRole('dialog', { name: 'Tacos' })
  if (await recipe.isVisible()) await recipe.getByRole('button', { name: 'Done', exact: true }).click()

  await page.getByRole('button', { name: 'Grocery', exact: true }).click()
  for (const line of ['8 tortillas', '1 lb ground beef', '1 cup cheddar']) {
    await expect(page.getByRole('listitem').filter({ hasText: line })).toBeVisible()
  }
})
