import type { Page } from '@playwright/test'
import { expect, inLocalCopy, stubAssistant, test, type App } from './fixtures'

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

/**
 * Settings → Data → Import a file: records as a Drafter export holds them,
 * merged into this device's own — the way in for a record only the server
 * writes, such as a recipe's overnight draft. Waits for the device's own copy
 * to hold them, and opens the planner again.
 */
async function importRecords(page: Page, app: App, items: Record<string, unknown>[], mark: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({ name: 'drafter.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 3, items })) })
  await expect(page.getByText(`Imported: ${items.length} new, 0 updated, 0 unchanged.`)).toBeAttached()
  await expect.poll(() => inLocalCopy(page, mark)).toBe(true)
  await app.open()
}

test('a draft made overnight waits in Fill them in: on screen at once, and Save puts it into the recipe', async ({ page, app }) => {
  // no assistant call: any would fail, and be counted
  const ai = await stubAssistant(page, [])
  await app.open()
  const at = new Date().toISOString()
  await importRecords(
    page,
    app,
    [
      { kind: 'recipe', id: 'e2e-tacos', name: 'Tacos', ingredients: [], tags: [], createdAt: at, updatedAt: at },
      {
        kind: 'recipedraft',
        id: 'recipedraft~e2e-tacos',
        recipeId: 'e2e-tacos',
        servings: 4,
        ingredients: [
          { name: 'tortillas', qty: 8 },
          { name: 'ground beef', qty: 1, unit: 'lb' },
        ],
        steps: ['Brown the beef.', 'Warm the tortillas.'],
        draftedAt: at,
        model: 'nvidia/nemotron-3-super-120b-a12b',
        createdAt: at,
        updatedAt: at,
      },
    ],
    'recipedraft~e2e-tacos',
  )

  await app.go('Keep')
  await page.getByRole('tab', { name: 'Kitchen' }).click()
  await page.getByRole('button', { name: 'Recipes', exact: true }).click()
  await expect(page.getByText('1 recipe has no ingredients — the grocery list can’t use it.')).toBeVisible()
  await page.getByRole('button', { name: 'Fill it in · 1 ready' }).click()
  const sheet = page.getByRole('dialog', { name: 'Fill in recipes' })
  await expect(sheet).toContainText('Drafted ahead of time — nothing is saved until you tap Save.')
  await expect(sheet.getByText('8 tortillas')).toBeVisible()
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sheet).toContainText('1 recipe filled in.')
  await sheet.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(sheet).toBeHidden()

  // the recipe has them now, and nothing is left to fill in
  await expect(page.getByText(/no ingredients — the grocery list/)).toHaveCount(0)
  await page.getByRole('listitem').filter({ hasText: 'Tacos' }).getByRole('button', { name: 'Tacos', exact: true }).click()
  const cook = page.getByRole('dialog', { name: 'Tacos' })
  await expect(cook.getByText('1 lb ground beef')).toBeVisible()
  expect(ai.asked).toEqual([])
})
