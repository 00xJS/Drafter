import { test as base, expect, type Page, type Route } from '@playwright/test'

export { expect }

/** Per project (playwright.config.ts): where the app is opened — with ?native=1 for the iPhone's iOS look. */
export interface AppOptions {
  appPath: string
}

export type View = 'Home' | 'Tasks' | 'Calendar' | 'Keep' | 'Insights'

/** The planner as a test drives it. */
export interface App {
  /** Open the app and wait for Today. Also how a test reopens it: a reload would drop ?native=1, which the app strips from the address. */
  open(): Promise<void>
  /** One of the five tabs, from whichever bar this layout shows (the top bar on a desktop, the tab bar on a phone). */
  go(view: View): Promise<void>
  /** Today's day key, YYYY-MM-DD, in the test's time zone. */
  today: string
}

export const test = base.extend<AppOptions & { app: App }>({
  appPath: ['/', { option: true }],
  app: async ({ page, appPath }, use) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date())
    await use({
      today,
      open: async () => {
        await page.goto(appPath)
        await expect(page.getByRole('main')).toBeVisible()
        await expect(page.getByRole('navigation').filter({ visible: true }).getByRole('button', { name: 'Home', exact: true })).toBeVisible()
      },
      go: async view => {
        await page.getByRole('navigation').filter({ visible: true }).getByRole('button', { name: view, exact: true }).click()
      },
    })
  },
})

/** One server-sent event, as /api/ai writes it (shared/sse.mts). */
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/**
 * /api/ai answered here, never by a model: the one proxy every assistant call
 * goes through (src/ai.ts). A request is told apart by its system prompt, and
 * anything unexpected fails the test rather than getting a made-up answer.
 * An answer with `stream: true` is sent as the server streams one, to a call
 * that asks for a stream — its words in pieces, then the whole — and every
 * other answer whole, as a server from before streaming sends it. `streamed`
 * says which each call got.
 */
export async function stubAssistant(page: Page, answers: { system: string; reply: unknown; stream?: boolean }[]): Promise<{ asked: string[]; streamed: boolean[] }> {
  const asked: string[] = []
  const streamed: boolean[] = []
  await page.route('**/api/ai', async (route: Route) => {
    const body = route.request().postDataJSON() as { system?: string; stream?: boolean }
    const hit = answers.find(a => body.system?.includes(a.system))
    asked.push(hit?.system ?? `unexpected: ${body.system?.slice(0, 80)}`)
    if (!hit) return route.fulfill({ status: 500, json: { error: 'unexpected assistant call in a test' } })
    const text = typeof hit.reply === 'string' ? hit.reply : JSON.stringify(hit.reply)
    streamed.push(!!(hit.stream && body.stream))
    if (!hit.stream || !body.stream) return route.fulfill({ json: { text } })
    const words = text.match(/[\s\S]{1,12}/g) ?? []
    await route.fulfill({
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' },
      body: [...words.map(piece => sse('delta', { text: piece })), sse('done', { text, provider: 'nvidia', model: 'test' })].join(''),
    })
  })
  return { asked, streamed }
}

/**
 * Whether the device's own copy (IndexedDB) holds this text yet. The planner
 * writes it there a moment after a change (syncengine.ts, PERSIST_MS), and a
 * page that goes away before then does not live to finish the write — so a
 * test waits for it before it reloads.
 */
export function inLocalCopy(page: Page, text: string): Promise<boolean> {
  return page.evaluate(async text => {
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const open = indexedDB.open('drafter')
      open.onsuccess = () => ok(open.result)
      open.onerror = () => fail(open.error)
    })
    try {
      for (const name of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>(ok => {
          const all = db.transaction(name).objectStore(name).getAll()
          all.onsuccess = () => ok(all.result)
          all.onerror = () => ok([])
        })
        if (JSON.stringify(rows).includes(text)) return true
      }
      return false
    } finally {
      db.close()
    }
  }, text)
}
