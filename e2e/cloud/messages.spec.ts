import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A message one member sends the household tells the other: once the server
// has it, the sender's app asks /api/notify to, naming the message by its id
// (src/activity.ts), and the server writes the other member's notice and
// pushes it (netlify/functions/notify.mjs — answered in the page here, so
// what is checked is the asking). The other member's open thread shows the
// message within seconds, carried by Realtime; a message that arrives that
// way is never told again by the device it arrives on.

/** Longer than a push's debounce, a round, a nudge and the queue's wait; far shorter than the live poll. */
const LIVE = { timeout: 10_000 }

/** The chat, from the top bar, on its household thread. */
async function openChat(page: Page) {
  await page.getByRole('button', { name: /^Chat/ }).click()
  const household = page.getByRole('tab', { name: 'Household' })
  await expect(household).toHaveAttribute('aria-selected', 'true')
}

/** Something said to the household: typed, and sent. */
async function say(page: Page, words: string) {
  await page.getByPlaceholder('Message the household…').fill(words)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('a message one member sends is told once the server has it, and shows in the other’s thread live', async ({ lane }) => {
  const [maria, sam] = await lane.household('Maria', 'Sam')
  const a = await lane.device(maria)
  const b = await lane.device(sam)
  await openChat(b.page)
  await openChat(a.page)

  const words = 'Home by six — shall I get milk?'
  await say(a.page, words)
  await expect(a.page.locator('.chat-thread')).toContainText(words)

  // on the server, as Maria's
  await expect.poll(() => lane.row('message', 'body', words), LIVE).toMatchObject({ user_id: maria.id, data: { kind: 'message', body: words } })
  const row = (await lane.row('message', 'body', words))!

  // her app told of it by its id, once, and only after the server had it
  await expect.poll(() => a.notified.filter(n => n.messageId === row.id).length, LIVE).toBe(1)
  expect(a.notified.filter(n => n.messageId)).toEqual([{ messageId: row.id, onServer: true }])

  // Sam's open thread shows it within seconds, under her name, carried by Realtime
  const thread = b.page.locator('.chat-thread')
  await expect(thread).toContainText(words, LIVE)
  await expect(thread.locator('.chat-line.theirs')).toContainText(words)
  expect(b.live.changes.some(frame => frame.includes(row.id))).toBe(true)

  // the device it arrived on never tells it again: only the one that wrote it does
  await a.settled()
  await b.settled()
  expect(b.notified).toEqual([])
  expect(a.notified.filter(n => n.messageId)).toHaveLength(1)
})
