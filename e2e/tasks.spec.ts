import { expect, stubAssistant, test } from './fixtures'

test('the palette files a dated task, which can then be completed', async ({ page, app }) => {
  await app.open()
  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByRole('dialog', { name: 'Search' })
  const line = palette.getByRole('combobox', { name: 'Search' })
  await line.fill('Water the plants tomorrow at 9am')
  // Shift+Enter files it as typed, with the date read offline: no editor, no model
  await line.press('Shift+Enter')
  await expect(palette).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Captured — due')

  await app.go('Tasks')
  const task = page.getByRole('button', { name: 'Water the plants', exact: true })
  await expect(task).toBeVisible()
  await expect(page.getByRole('main')).toContainText('Tomorrow 9:00 AM')

  await task.click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByRole('button', { name: 'Done', exact: true }).click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
  // gone from the open tasks, and there among the done ones
  await expect(task).toBeHidden()
  await page.getByRole('combobox', { name: 'Filter by status' }).selectOption('done')
  await expect(page.getByRole('button', { name: 'Water the plants', exact: true })).toBeVisible()
})

test('the assistant proposes a task: Apply adds it, Undo takes it away', async ({ page, app }) => {
  const ai = await stubAssistant(page, [
    {
      system: "You are the assistant inside a household's own planner.",
      reply: { answer: 'Here is a task you could add.', cites: [], actions: [{ type: 'create_task', title: 'Book the dentist', priority: 'normal' }] },
    },
  ])
  await app.open()
  const openAssistant = async () => {
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByRole('tab', { name: 'Assistant' }).click()
  }
  await openAssistant()
  await page.getByPlaceholder('Ask about your week…').fill('Remind me to book the dentist')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const card = page.getByRole('list', { name: 'Suggested changes' }).getByRole('listitem').filter({ hasText: 'Book the dentist' })
  await card.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(card).toContainText('Applied')
  expect(ai.asked).toEqual(["You are the assistant inside a household's own planner."])

  await app.go('Tasks')
  await expect(page.getByRole('button', { name: 'Book the dentist', exact: true })).toBeVisible()

  await openAssistant()
  await card.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Apply', exact: true })).toBeVisible()
  await app.go('Tasks')
  await expect(page.getByRole('button', { name: 'Book the dentist', exact: true })).toBeHidden()
})
