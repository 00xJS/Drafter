import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The notification hub behind the bell on Home. In local mode there is no
// account, so no notices: what it can show here is the reminders this device
// rang in the last week — worked out again from the rules that set them, and
// counted on the bell until the hub is next opened. The clock is Playwright's,
// so "9:30 this morning" is always behind it.

/** Wednesday 23 September 2026, 10:00 in Phoenix (the config's zone). */
const NOW = new Date('2026-09-23T17:00:00Z')

/** A task through the editor, due at a local YYYY-MM-DDTHH:mm: its day and its time, in a field each. */
async function file(page: Page, title: string, due: string) {
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'New task' })
  await editor.getByPlaceholder('e.g. Book the electrician').fill(title)
  await editor.getByLabel('Due', { exact: true }).fill(due.slice(0, 10))
  await editor.getByLabel('Due time').fill(due.slice(11, 16))
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
}

test('the bell sits on Home’s title line and opens the hub, which says when there is nothing', async ({ page, app }) => {
  await page.clock.install({ time: NOW })
  await app.open()
  // an empty planner's Home is one welcome card: a task tomorrow draws the day
  await file(page, 'Fix the fence', '2026-09-24T09:00')
  const bell = page.getByRole('button', { name: 'Notifications', exact: true })
  await expect(bell).toBeVisible()
  // inside the page beside Review, at the phone's width as at the desktop's
  const [box, review] = await Promise.all([bell.boundingBox(), page.getByRole('button', { name: 'Review', exact: true }).boundingBox()])
  expect(box!.x + box!.width).toBeLessThanOrEqual(review!.x)
  expect(review!.x + review!.width).toBeLessThanOrEqual(page.viewportSize()!.width)

  await bell.click()
  const hub = page.getByRole('dialog', { name: 'Notifications' })
  await expect(hub).toContainText('You’re all caught up.')
  await expect(hub.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0)
  await hub.getByRole('button', { name: 'Close' }).click()
  await expect(hub).toBeHidden()
})

test('a reminder that rang is in the hub, counted on the bell until the hub is opened', async ({ page, app }) => {
  // A browser rings only once it may show notifications (src/hub.ts
  // ringingDevice). A headless browser answers "denied" whatever is granted,
  // so the page is told it may: what is under test is the hub, not the prompt.
  await page.addInitScript(() => {
    if (typeof Notification !== 'undefined') Object.defineProperty(Notification, 'permission', { get: () => 'granted' })
  })
  await page.clock.install({ time: NOW })
  await app.open()
  // Safari on an iPhone has no notifications for a page in a tab, so it rings nothing to list
  test.skip(!(await page.evaluate(() => typeof Notification !== 'undefined')), 'this browser cannot show notifications at all')
  await file(page, 'Take bins out', '2026-09-23T09:30')

  const counted = page.getByRole('button', { name: 'Notifications, 1 unread' })
  await expect(counted).toBeVisible()
  await counted.click()
  const hub = page.getByRole('dialog', { name: 'Notifications' })
  await expect(hub.getByRole('region', { name: 'Today' })).toContainText('Reminder · Take bins out was due 9:30 AM')
  await hub.getByRole('button', { name: 'Close' }).click()
  await expect(hub).toBeHidden()

  // opened once, it is seen: the bell no longer counts it
  const bell = page.getByRole('button', { name: 'Notifications', exact: true })
  await expect(bell).toBeVisible()
  // …and it is still there to read, and opens the task
  await bell.click()
  await hub.getByRole('button', { name: /Reminder · Take bins out/ }).click()
  await expect(hub).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
})
