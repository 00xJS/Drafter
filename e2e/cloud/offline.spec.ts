import { expect, test, type Device } from './fixtures'
import { lit, sqlAs } from './stack'

// A device that loses its connection keeps what is written on it and says so
// on the pill; once it is back, a round takes it to the server and a nudge to
// the other member. Both browsers are live first (lane.device), as in
// household.spec.ts: arrival inside ten seconds is Realtime's doing.

const LIVE = { timeout: 10_000 }

/** Rename a task through its editor. */
async function rename(d: Device, from: string, to: string): Promise<void> {
  const editor = await d.edit(from)
  await editor.getByLabel('Title', { exact: true }).fill(to)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
}

test('edits made offline reach the other member once the device is back, and nothing is lost', async ({ lane }) => {
  const [maria, sam] = await lane.household('Maria', 'Sam')
  const a = await lane.device(maria)
  const b = await lane.device(sam)
  await b.go('Tasks')
  await a.newTask('Paint the fence', { shared: true })
  await expect(b.task('Paint the fence')).toBeVisible(LIVE)
  const before = (await lane.row('task', 'title', 'Paint the fence'))!

  await a.offline(true)
  await rename(a, 'Paint the fence', 'Paint the fence green')
  await a.newTask('Buy brushes', { shared: true })
  // kept on the device, and said so
  await expect(a.pill).toHaveAccessibleName('Offline — tap to retry', LIVE)
  await expect(a.pill).toContainText('2 unsynced', LIVE)
  // nothing of it has left: the server and Sam still have the old title, and no brushes
  expect(await lane.row('task', 'title', 'Paint the fence')).toMatchObject({ id: before.id })
  expect(await lane.row('task', 'title', 'Buy brushes')).toBeNull()
  await expect(b.task('Paint the fence')).toBeVisible()

  await a.offline(false)
  await expect(b.task('Paint the fence green')).toBeVisible(LIVE)
  await expect(b.task('Buy brushes')).toBeVisible(LIVE)
  // renamed where it stood, not copied
  await expect(b.task('Paint the fence')).toHaveCount(0)
  expect(await lane.row('task', 'title', 'Paint the fence green')).toMatchObject({ id: before.id, user_id: maria.id })
  expect(await lane.row('task', 'title', 'Buy brushes')).toMatchObject({ user_id: maria.id })
  await a.settled()
  await b.settled()

  // and Maria's own device still has both after a reload
  await a.page.reload()
  await a.go('Tasks')
  await expect(a.task('Paint the fence green')).toBeVisible()
  await expect(a.task('Buy brushes')).toBeVisible()
  await a.settled()
})

test('both members rename one task offline: the later edit is kept on both devices, and neither stays unsynced', async ({ lane }) => {
  const [maria, sam] = await lane.household('Maria', 'Sam')
  const a = await lane.device(maria)
  const b = await lane.device(sam)
  await b.go('Tasks')
  await a.newTask('Clean the gutters', { shared: true })
  await expect(b.task('Clean the gutters')).toBeVisible(LIVE)

  await a.offline(true)
  await b.offline(true)
  // Maria first, then Sam: Sam's is the later edit
  await rename(a, 'Clean the gutters', 'Clean the gutters on Saturday')
  await expect(a.pill).toContainText('1 unsynced', LIVE)
  await rename(b, 'Clean the gutters', 'Clean the gutters on Sunday')
  await expect(b.pill).toContainText('1 unsynced', LIVE)
  const hers = (await a.held('Clean the gutters on Saturday'))!
  const his = (await b.held('Clean the gutters on Sunday'))!
  expect(his.id).toBe(hers.id)
  expect(Date.parse(his.updatedAt)).toBeGreaterThan(Date.parse(hers.updatedAt))

  // Sam's device is back first, so the later edit reaches the server first.
  // Where both devices changed one field, the merge keeps the server's copy
  // (shared/merge.mts), which makes this the order in which the later edit is
  // the one both keep: Maria's device takes it in as it comes back, and says so.
  await b.offline(false)
  await expect.poll(() => lane.row('task', 'title', 'Clean the gutters on Sunday'), LIVE).toMatchObject({ id: his.id })
  await b.settled()
  await a.offline(false)
  await expect(a.task('Clean the gutters on Sunday')).toBeVisible(LIVE)
  await expect(a.task('Clean the gutters on Saturday')).toHaveCount(0)
  await expect(a.page.getByRole('status').filter({ hasText: 'changed on another device too' })).toHaveText(/^“Clean the gutters on Saturday” changed on another device too — kept the newer edit/)

  // neither device is left with anything to push, and both hold Sam's version, stamp and all
  await a.settled()
  await b.settled()
  await expect(b.task('Clean the gutters on Sunday')).toBeVisible()
  const kept = (await lane.row('task', 'title', 'Clean the gutters on Sunday'))!
  expect(kept.data.updatedAt).toBe(his.updatedAt)
  expect(await a.held('Clean the gutters on Sunday')).toEqual(his)
  expect(await b.held('Clean the gutters on Sunday')).toEqual(his)
  expect(await lane.row('task', 'title', 'Clean the gutters on Saturday')).toBeNull()

  // Whatever a device sends, the server keeps the later stamp: Maria's copy
  // offered again through sync_posts comes back stale, with the one it lost
  // to, and written straight to the table, the last-write-wins trigger refuses it.
  const older = JSON.stringify({ ...kept.data, title: 'Clean the gutters on Saturday', updatedAt: hers.updatedAt })
  const offered = JSON.parse(await sqlAs(lane.stack, maria, `select public.sync_posts(jsonb_build_array(${lit(older)}::jsonb), now())`)) as { stale: string[]; items: { id: string; title?: string }[] }
  expect(offered.stale).toEqual([his.id])
  expect(offered.items).toEqual([expect.objectContaining({ id: his.id, title: 'Clean the gutters on Sunday' })])
  await expect(sqlAs(lane.stack, maria, `update public.posts set data = ${lit(older)}::jsonb, updated_at = ${lit(hers.updatedAt)} where id = ${lit(his.id)}`)).rejects.toThrow(
    /stale write rejected/,
  )
})
