import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { View } from '../fixtures'
import { stubApi, type ApiLog, type Notified } from './api'
import { isLocalHost, type Stack } from './lane'
import { createMember, makeHousehold, serverRow, type Member, type ServerRow } from './stack'

export { expect }
export type { Member }

/** Per run (playwright.cloud.config.ts): the local stack, or why there is none. */
export interface CloudOptions {
  stack: Stack | null
  skipReason: string
}

/**
 * What a page's live channel has said, read off its socket: the same frames
 * src/realtime.ts listens to. `joined` is the server saying the postgres_changes
 * subscription is on — from then the engine's own poll runs every five minutes
 * (LIVE_PERIODIC_MS), so a change that arrives within seconds came as a nudge.
 */
export interface Live {
  readonly joined: boolean
  /** Changes the server delivered, as the text of their frames. */
  readonly changes: readonly string[]
}

/** One member's browser: a context of its own, signed in to the local stack. */
export interface Device {
  who: Member
  page: Page
  context: BrowserContext
  live: Live
  /** The top bar's sync pill: what is waiting, and whether the last round got an answer. */
  pill: Locator
  /** What this device told /api/notify, in order, and whether the server had the record it named as it asked. */
  readonly notified: readonly Notified[]
  /** Sign in through the form, as a person does, and wait for Home. */
  signIn(): Promise<void>
  /** One of the five tabs. */
  go(view: View): Promise<void>
  /**
   * A task through the New task editor: a title, and Save. A new task is its
   * writer's until they share it (TaskEditor.tsx), so one meant for the
   * household says so under Who can see it.
   */
  newTask(title: string, opts?: { shared?: boolean }): Promise<void>
  /** A task's row on Tasks, by its title (Tasks must be showing). */
  task(title: string): Locator
  /** Tasks, then a task's editor. */
  edit(title: string): Promise<Locator>
  /** The browser's connection, cut or back: the page is told, as a phone's is. */
  offline(on: boolean): Promise<void>
  /**
   * Nothing left to push, in this device's saved bookkeeping, and the pill
   * says the last round answered. A final state: the pill only counts what is
   * waiting once a round has tried it, so an edit made a moment ago can look
   * settled before it has gone — wait for the server (lane.row) for that.
   */
  settled(): Promise<void>
  /** The task this device holds under `title`, as its saved copy has it; null when it holds none. */
  held(title: string): Promise<{ id: string; title: string; updatedAt: string } | null>
}

export interface Lane {
  stack: Stack
  /** A new account on the stack. */
  member(label: string): Promise<Member>
  /** New accounts, one household, the first its owner. */
  household(...labels: string[]): Promise<Member[]>
  /** A browser for `who`, signed in, synced and live, unless asked to stop at the sign-in page. */
  device(who: Member, opts?: { signedIn?: boolean }): Promise<Device>
  /** The server's row of `kind` whose `field` is `value`, among this test's accounts; null when there is none. */
  row(kind: string, field: string, value: string): Promise<ServerRow | null>
}

const nav = (page: Page, view: View) => page.getByRole('navigation').filter({ visible: true }).getByRole('button', { name: view, exact: true })

/**
 * Read this device's saved copy (src/idb.ts): the records, one row each by id
 * in 'records', and beside them in 'meta' the bookkeeping, whose `dirty` is
 * every record still to push. Written a moment after each change (PERSIST_MS).
 */
function savedCopy(page: Page): Promise<{ records: unknown[]; dirty: string[] }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const open = indexedDB.open('drafter')
      open.onsuccess = () => ok(open.result)
      open.onerror = () => fail(open.error)
    })
    try {
      if (!db.objectStoreNames.contains('records') || !db.objectStoreNames.contains('meta')) return { records: [], dirty: [] }
      const read = <T>(req: IDBRequest<T>) =>
        new Promise<T | undefined>(ok => {
          req.onsuccess = () => ok(req.result)
          req.onerror = () => ok(undefined)
        })
      const tx = db.transaction(['records', 'meta'])
      const [records, meta] = await Promise.all([read(tx.objectStore('records').getAll()), read(tx.objectStore('meta').get('cache'))])
      const dirty = (meta as { sync?: { dirty?: unknown } } | undefined)?.sync?.dirty
      return { records: records ?? [], dirty: Array.isArray(dirty) ? dirty.map(String) : [] }
    } finally {
      db.close()
    }
  })
}

/** A Realtime frame as realtime-js sends it: [join_ref, ref, topic, event, payload] (vsn 2.0.0), or the 1.0.0 object. */
function frameOf(payload: string | Buffer): { event?: unknown; payload?: { extension?: unknown; status?: unknown } } | null {
  if (typeof payload !== 'string') return null
  try {
    const msg = JSON.parse(payload) as unknown
    if (Array.isArray(msg) && msg.length === 5) return { event: msg[3], payload: msg[4] }
    return msg && typeof msg === 'object' ? (msg as { event?: unknown; payload?: { extension?: unknown; status?: unknown } }) : null
  } catch {
    return null
  }
}

/** Follow the page's Realtime sockets from before it opens any. */
function watchLive(page: Page, stack: Stack): Live {
  const socket = new URL('/realtime/v1/websocket', stack.url)
  const joined = new Set<object>()
  const changes: string[] = []
  page.on('websocket', ws => {
    const url = new URL(ws.url())
    if (url.host !== socket.host || url.pathname !== socket.pathname) return
    ws.on('framereceived', ({ payload }) => {
      const msg = frameOf(payload)
      if (msg?.event === 'system' && msg.payload?.extension === 'postgres_changes') {
        if (msg.payload.status === 'ok') joined.add(ws)
        else joined.delete(ws)
      }
      if (msg?.event === 'postgres_changes') changes.push(String(payload))
    })
    ws.on('close', () => joined.delete(ws))
  })
  return {
    get joined() {
      return joined.size > 0
    },
    changes,
  }
}

interface Opened {
  device: Device
  log: ApiLog
  /** Requests and sockets the page tried to open to another host, and was refused. */
  refused: string[]
  console: string[]
}

async function openDevice(browser: Browser, stack: Stack, origin: string, who: Member): Promise<Opened> {
  const context = await browser.newContext()
  // Nothing leaves this machine. The config refuses a hosted stack and
  // global-setup reads the bundle back; this is the last line: a request or a
  // socket to any other host is refused, and the test hears of it.
  const refused: string[] = []
  await context.route(
    url => !isLocalHost(url.hostname),
    route => {
      refused.push(route.request().url())
      return route.abort('blockedbyclient')
    },
  )
  await context.routeWebSocket(
    url => !isLocalHost(url.hostname),
    ws => {
      refused.push(ws.url())
      return ws.close()
    },
  )
  const page = await context.newPage()
  const consoleLines: string[] = []
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  const log = await stubApi(page, stack, origin)
  const live = watchLive(page, stack)
  const pill = page.locator('.sync-btn')

  const device: Device = {
    who,
    page,
    context,
    live,
    pill,
    notified: log.notified,
    // GoTrue takes 30 sign-ins in five minutes from one address (supabase/config.toml,
    // [auth.rate_limit]); the lane signs in ten times, twice that when every test retries
    async signIn() {
      await page.goto('/')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.getByLabel('Email', { exact: true }).fill(who.email)
      await page.getByLabel('Password', { exact: true }).fill(who.password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      // the planner is its own chunk, fetched once the session is there
      await expect(nav(page, 'Home')).toHaveAttribute('aria-current', 'page', { timeout: 15_000 })
    },
    async go(view) {
      await nav(page, view).click()
      await expect(nav(page, view)).toHaveAttribute('aria-current', 'page')
    },
    async newTask(title, { shared = false } = {}) {
      await page.getByRole('button', { name: 'New task', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'New task' })
      await editor.getByPlaceholder('e.g. Book the electrician').fill(title)
      if (shared) {
        const share = editor.getByRole('button', { name: 'Shared' })
        await share.click()
        await expect(share).toHaveAttribute('aria-pressed', 'true')
      }
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(editor).toBeHidden()
    },
    task: title => page.getByRole('main').getByRole('button', { name: title, exact: true }),
    async edit(title) {
      await device.go('Tasks')
      await device.task(title).click()
      const editor = page.getByRole('dialog', { name: 'Edit task' })
      await expect(editor).toBeVisible()
      return editor
    },
    offline: on => context.setOffline(on),
    async settled() {
      await expect.poll(async () => (await savedCopy(page)).dirty, { message: `${who.name}'s device still has edits to push`, timeout: 15_000 }).toEqual([])
      await expect(pill).toHaveAccessibleName('Synced — tap to sync now', { timeout: 15_000 })
      await expect(pill).not.toContainText('unsynced')
    },
    async held(title) {
      const { records } = await savedCopy(page)
      const task = records.find((r): r is { id: string; title: string; updatedAt: string } => {
        const t = r as { kind?: unknown; title?: unknown }
        return t.kind === 'task' && t.title === title
      })
      return task ? { id: task.id, title: task.title, updatedAt: task.updatedAt } : null
    },
  }
  return { device, log, refused, console: consoleLines }
}

/** What a test leaves behind for whoever reads a failure: every /api call, client error, console line and refusal. */
async function attach(testInfo: TestInfo, opened: Opened[]): Promise<void> {
  for (const o of opened) {
    const body = JSON.stringify({ member: o.device.who.email, api: o.log.calls, unexpected: o.log.unexpected, reports: o.log.reports, refused: o.refused, console: o.console }, null, 2)
    await testInfo.attach(`${o.device.who.name}.json`, { body, contentType: 'application/json' })
  }
}

export const test = base.extend<CloudOptions & { lane: Lane }>({
  stack: [null, { option: true }],
  skipReason: ['', { option: true }],
  lane: async ({ stack, skipReason, browser, baseURL }, use, testInfo) => {
    testInfo.skip(!stack, skipReason)
    const opened: Opened[] = []
    const members: Member[] = []
    const origin = new URL(baseURL!).origin
    const lane: Lane = {
      stack: stack!,
      async member(label) {
        const m = await createMember(stack!, label)
        members.push(m)
        return m
      },
      async household(...labels) {
        const made = await Promise.all(labels.map(label => lane.member(label)))
        await makeHousehold(stack!, made[0], ...made.slice(1))
        return made
      },
      row: (kind, field, value) => serverRow(stack!, members, kind, field, value),
      async device(who, { signedIn = true } = {}) {
        const o = await openDevice(browser, stack!, origin, who)
        opened.push(o)
        if (!signedIn) return o.device
        await o.device.signIn()
        // The first round has answered and the channel is up: from here a
        // change on the other device arrives as a nudge. A fresh stack's first
        // subscription also starts Realtime's replication, so it gets longer.
        await o.device.settled()
        await expect.poll(() => o.device.live.joined, { message: `${who.name}'s live channel never joined`, timeout: 30_000 }).toBe(true)
        return o.device
      },
    }
    await use(lane)
    await attach(testInfo, opened)
    for (const o of opened) {
      // a stub still answering when its page goes is not an error
      await o.device.page.unrouteAll({ behavior: 'ignoreErrors' })
      await o.device.context.close()
    }
    // the page asked /api for something e2e/cloud/api.ts does not answer: stub it on purpose
    expect(opened.flatMap(o => o.log.unexpected.map(call => `${o.device.who.name}: ${call}`))).toEqual([])
    // and nothing went, or tried to go, anywhere but this machine
    expect(opened.flatMap(o => o.refused)).toEqual([])
  },
})
