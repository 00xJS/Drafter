import { expect, inLocalCopy, test } from './fixtures'

// the one test that needs the service worker: it is what answers offline
test.use({ serviceWorkers: 'allow' })

test('offline, the app and what is in it still open', async ({ page, context, app, browserName }) => {
  // Playwright's WebKit goes offline beneath the service worker: a reload ends in
  // "WebKit encountered an internal error", and a lazy chunk the worker holds
  // fails to import. Chromium runs the worker's own offline path.
  test.skip(browserName === 'webkit', 'offline emulation in Playwright’s WebKit bypasses the service worker')
  await app.open()
  await page.keyboard.press('ControlOrMeta+K')
  const line = page.getByRole('dialog', { name: 'Search' }).getByRole('combobox', { name: 'Search' })
  await line.fill('Pay the water bill')
  await line.press('Shift+Enter')
  await expect(page.getByRole('status')).toContainText('Captured')
  await expect.poll(() => inLocalCopy(page, 'Pay the water bill')).toBe(true)

  // the worker has installed, precached the app, and taken this page over
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('main')).toBeVisible()
  await app.go('Tasks')
  await expect(page.getByRole('button', { name: 'Pay the water bill', exact: true })).toBeVisible()
  await context.setOffline(false)
})
