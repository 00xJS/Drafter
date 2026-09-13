// Keeping the web app on the newest deploy.
//
// The service worker keeps a copy of the app so it opens offline. It used to
// serve that copy first, and looked for a new worker only on a full page load:
// after a deploy a refresh still showed the old version, and a tab left open or
// the Home Screen app resumed from the background kept it until the site's
// data was cleared.
//
// Now:
//   - pages come from the network first (vite.config.ts), so a refresh or a
//     fresh load is the newest deploy; the saved copy is the offline fallback;
//   - every load, return to the app, regained focus and coming back online
//     (at most once a minute) re-checks the worker — sw.js and what it
//     imports, never from the HTTP cache — and compares this page's build with
//     the server's /version.json;
//   - an older page moves onto the new version: when the new worker takes
//     over, or, if none has arrived ten seconds after the server said it is
//     newer, once the worker and its caches are cleared the way "clear site
//     data" would. The reload waits until nothing is being edited, and the
//     clearing happens at most once per new build, so a deploy that is still
//     propagating cannot make it loop. Records and settings are not caches and
//     are never touched.

const TRIED_KEY = 'drafter:update-tried'
const CHECK_EVERY_MS = 60_000
const GIVE_WORKER_MS = 10_000
const IDLE_POLL_MS = 2_000

/** The build this page was loaded from, stamped into index.html (vite.config.ts); 'dev' under Vite's dev server. */
export function pageBuild(doc: Pick<Document, 'querySelector'> = document): string {
  return doc.querySelector<HTMLMetaElement>('meta[name="drafter-build"]')?.content || 'dev'
}

/** What this tab has already tried for a newer server build. */
export type Tried = 'none' | 'update' | 'reset'
export type UpdateStep = 'current' | 'wait' | 'reset' | 'give-up'

/**
 * The next step when this page is build `running` and the server says `server`
 * (null when it could not be asked — offline, or the dev server). A newer build
 * first gets the chance to arrive as a new worker; if it has not, the caches go;
 * after that, nothing more is tried in this tab.
 */
export function updateStep(running: string, server: string | null, tried: Tried): UpdateStep {
  if (!server || server === running) return 'current'
  if (tried === 'none') return 'wait'
  if (tried === 'update') return 'reset'
  return 'give-up'
}

/** Mid-edit: a dialog is open or a field has the cursor. A reload now would drop what is not saved yet. */
export function busy(doc: Pick<Document, 'querySelector' | 'activeElement'> = document): boolean {
  if (doc.querySelector('[role="dialog"]')) return true
  const el = doc.activeElement as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

/** Run `fn` now, or as soon as nothing is being edited. */
function whenIdle(fn: () => void): void {
  if (!busy()) return fn()
  const timer = setInterval(() => {
    if (busy()) return
    clearInterval(timer)
    fn()
  }, IDLE_POLL_MS)
}

/** What was tried for `server`; a different build starts again from nothing. */
export function readTried(server: string | null, store: Pick<Storage, 'getItem'> | null = session()): Tried {
  if (!server || !store) return 'none'
  try {
    const saved = JSON.parse(store.getItem(TRIED_KEY) ?? 'null') as { build?: unknown; tried?: unknown } | null
    return saved?.build === server && (saved.tried === 'update' || saved.tried === 'reset') ? saved.tried : 'none'
  } catch {
    return 'none'
  }
}

function session(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function writeTried(server: string, tried: Tried): void {
  try {
    session()?.setItem(TRIED_KEY, JSON.stringify({ build: server, tried }))
  } catch {
    /* private mode: at worst a stale tab tries again next time */
  }
}

function clearTried(): void {
  try {
    session()?.removeItem(TRIED_KEY)
  } catch {
    /* nothing to clear */
  }
}

/** The build the server is on, or null when it cannot say. Never from a cache. */
async function serverBuild(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { build?: unknown }
    return typeof body.build === 'string' && body.build ? body.build : null
  } catch {
    return null
  }
}

/** What "clear site data" does to the app's own copy: the worker and its caches. */
async function clearAppCache(): Promise<void> {
  const regs = (await navigator.serviceWorker?.getRegistrations?.().catch(() => [])) ?? []
  await Promise.all(regs.map(r => r.unregister().catch(() => false)))
  if ('caches' in window) {
    const keys = await caches.keys().catch(() => [] as string[])
    await Promise.all(keys.map(k => caches.delete(k).catch(() => false)))
  }
}

/** Register the service worker and keep this tab on the newest deploy. Web only: the iOS app is its own bundle. */
export function startAppUpdates(): void {
  if (!('serviceWorker' in navigator)) return
  const sw = navigator.serviceWorker
  const running = pageBuild()
  let reloading = false

  // A first install takes control without a reload. A replacement reloads only
  // a page older than the server: a page that came from the network is already
  // the new version by the time its worker catches up.
  let hadController = !!sw.controller
  sw.addEventListener('controllerchange', () => {
    const replaced = hadController
    hadController = true
    if (!replaced || reloading) return
    void serverBuild().then(server => {
      if (server === running || reloading) return
      reloading = true
      whenIdle(() => location.reload())
    })
  })

  const registered = sw.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => undefined)

  let last = 0
  let followUp: ReturnType<typeof setTimeout> | undefined
  const later = () => {
    clearTimeout(followUp)
    followUp = setTimeout(() => void check(true), GIVE_WORKER_MS)
  }
  const check = async (force = false): Promise<void> => {
    const now = Date.now()
    if (reloading || (!force && now - last < CHECK_EVERY_MS)) return
    last = now
    const reg = await registered
    await reg?.update().catch(() => undefined)
    const server = await serverBuild()
    const step = updateStep(running, server, readTried(server))
    if (step === 'current') return clearTried()
    if (!server || step === 'give-up' || reloading) return
    if (step === 'wait') {
      writeTried(server, 'update')
      return later()
    }
    // still downloading the new version is slow, not stuck
    if (reg?.installing) return later()
    writeTried(server, 'reset')
    reloading = true
    whenIdle(() => void clearAppCache().then(() => location.reload()))
  }

  void check(true)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
  window.addEventListener('focus', () => void check())
  window.addEventListener('online', () => void check(true))
}
