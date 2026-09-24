import { inLocalCopy } from '../fixtures'
import { expect, test } from './fixtures'

test('sign in with email and password, land on Home, and sign out', async ({ lane }) => {
  const maria = await lane.member('Maria')
  const a = await lane.device(maria, { signedIn: false })
  const { page } = a

  // the landing page, then the form, then Home: an account with nothing in it yet
  await a.signIn()
  await expect(page.getByRole('heading', { name: 'Welcome to your planner' })).toBeVisible()
  await a.settled()

  // what this device writes reaches the server, under this account
  await a.newTask('Renew the passport')
  await expect.poll(() => lane.row('task', 'title', 'Renew the passport'), { timeout: 10_000 }).toMatchObject({ user_id: maria.id })
  await a.settled()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByText(`Signed in as ${maria.email}.`)).toBeVisible()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()

  // the page starts again on the landing page — the planner is not behind
  // it — and this device's copy went with the session
  const landing = page.getByRole('heading', { level: 1, name: /well-run project/ })
  await expect(landing).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  expect(await inLocalCopy(page, 'Renew the passport')).toBe(false)
  await page.reload()
  await expect(landing).toBeVisible()

  // signing in again brings it back from the server
  await a.signIn()
  await a.go('Tasks')
  await expect(a.task('Renew the passport')).toBeVisible({ timeout: 10_000 })
})
