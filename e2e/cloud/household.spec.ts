import { inLocalCopy } from '../fixtures'
import { expect, test } from './fixtures'
import { lit, sqlAs } from './stack'

// Two members of one household, each in a browser of their own. Both
// channels are live before anything is written (lane.device waits for it),
// and from then the engine polls only every five minutes: whatever reaches the
// other browser within ten seconds was carried by Realtime.

/** Longer than a push's debounce, a round and a nudge's; far shorter than the live poll. */
const LIVE = { timeout: 10_000 }

test('a task one member adds reaches the other within seconds, and so does its completion', async ({ lane }) => {
  const [maria, sam] = await lane.household('Maria', 'Sam')
  const a = await lane.device(maria)
  const b = await lane.device(sam)
  await a.go('Tasks')
  await b.go('Tasks')

  await a.newTask('Fix the gate', { shared: true })
  await expect(a.task('Fix the gate')).toBeVisible()
  await expect(b.task('Fix the gate')).toBeVisible(LIVE)
  expect(b.live.changes.length).toBeGreaterThan(0)

  const heard = a.live.changes.length
  const editor = await b.edit('Fix the gate')
  await editor.getByRole('button', { name: 'Done', exact: true }).click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()

  // on Maria's list: gone from the open tasks, and there among the done ones
  await expect(a.task('Fix the gate')).toBeHidden(LIVE)
  expect(a.live.changes.length).toBeGreaterThan(heard)
  await a.page.getByRole('combobox', { name: 'Filter by status' }).selectOption('done')
  await expect(a.task('Fix the gate')).toBeVisible()
  // still Maria's task; Sam only finished it
  expect(await lane.row('task', 'title', 'Fix the gate')).toMatchObject({ user_id: maria.id, data: { status: 'done' } })
  await a.settled()
  await b.settled()
})

test('what a member keeps to themselves never reaches the other: a journal entry, and a task left private', async ({ lane }) => {
  const [maria, sam] = await lane.household('Maria', 'Sam')
  const a = await lane.device(maria)
  const b = await lane.device(sam)
  const entry = 'The gate squeaks less since the oil.'
  // a new task is its writer's until they share it
  const present = 'Buy Sam a birthday present'
  const journal = async (page: typeof a.page) => {
    await page.getByRole('tablist', { name: 'Insights view' }).getByRole('tab', { name: 'Journal' }).click()
    return page.getByPlaceholder('What happened, what you noticed, what you want to remember…')
  }

  await a.go('Insights')
  await (await journal(a.page)).fill(entry)
  await expect(a.page.getByText(/^Saved \d/)).toBeVisible()
  await a.newTask(present)

  // both on the server, as Maria's, and the posts policy keeps them from Sam:
  // the journal because the kind is personal (record_kinds), the task by its own flag
  await expect.poll(() => lane.row('journal', 'body', entry), LIVE).toMatchObject({ user_id: maria.id })
  await expect.poll(() => lane.row('task', 'title', present), LIVE).toMatchObject({ user_id: maria.id, data: { shared: false } })
  for (const [kind, field, value] of [['journal', 'body', entry], ['task', 'title', present]]) {
    const row = (await lane.row(kind, field, value))!
    expect(await sqlAs(lane.stack, sam, `select count(*) from public.posts where id = ${lit(row.id)}`)).toBe('0')
  }
  await a.settled()

  // A shared task Maria adds after them reaches Sam: Realtime delivers in
  // commit order, and every round since asked for rows newer than both, so by
  // the time it is on Sam's list they have had every chance to arrive, as a
  // change on the socket or a row in a round.
  await b.go('Tasks')
  await a.newTask('Oil the gate again', { shared: true })
  await expect(b.task('Oil the gate again')).toBeVisible(LIVE)
  // the same question of the policy, asked of a row Sam may read, says yes
  const shared = (await lane.row('task', 'title', 'Oil the gate again'))!
  expect(await sqlAs(lane.stack, sam, `select count(*) from public.posts where id = ${lit(shared.id)}`)).toBe('1')

  for (const text of [entry, present]) {
    expect(b.live.changes.filter(frame => frame.includes(text))).toEqual([])
    expect(await inLocalCopy(b.page, text)).toBe(false)
  }
  await expect(b.task(present)).toHaveCount(0)
  await b.go('Insights')
  await expect(await journal(b.page)).toHaveValue('')
  await expect(b.page.getByText(entry)).toHaveCount(0)
})
