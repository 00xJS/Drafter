import { Capacitor } from '@capacitor/core'
import { COUNT_MAX, cleanReport, type CleanReport, type ReportPlatform } from '../shared/errorreport.mjs'
import { apiFetch } from './api'
import { pageBuild } from './appupdate'
import { getSupabase } from './supabase'

// Client error reports (v3.29).
//
// Until now a crash on a device reached nobody: the ErrorBoundary wrote it to
// that device's console, nothing listened for an error thrown outside React
// or a promise nobody caught, and most catch blocks swallow. Now the app
// tells the site owner, who sees it in Admin → Data (netlify/functions/log.mjs
// keeps it; public.client_errors holds it).
//
// What a report carries is decided by shared/errorreport.mjs, here and again
// on the server: the error's message and stack (trimmed, with every query
// string, email address and long quoted run taken out), the build, web or the
// iOS shell, which screen, and the page's path. Never a record, a title or
// anything typed.
//
// Reports wait a moment and go together; the same error again within ten
// minutes is counted on the one still waiting, or not sent at all. Offline or
// signed out, a report is dropped rather than kept: an error is not worth a
// queue, and a device that is not signed in has no account to send it as.

/** The same error again within this long is counted on the report still waiting, or not sent. */
export const DEDUPE_MS = 10 * 60_000
/** A report waits this long for company, so a burst goes as one request. */
export const FLUSH_DELAY_MS = 3_000
/** Reports per request (the server takes ten). */
export const BATCH_MAX = 10
/** The most that ever wait; past it a new error is dropped. */
export const QUEUE_MAX = 20

/** Browser noise that says nothing about Drafter. */
const IGNORED = [/^(?:\w*Error: )?ResizeObserver loop/i, /^(?:\w*Error: )?Script error\.?$/i]

/** The screens a report may name when it was not a view of its own that failed. */
const SCREENS = new Set(['home', 'calendar', 'tasks', 'keep', 'insights', 'settings', 'chat', 'admin'])

export interface ReporterDeps {
  send(reports: CleanReport[], keepalive: boolean): Promise<unknown>
  signedIn(): Promise<boolean>
  online(): boolean
  build(): string
  platform(): ReportPlatform
  view(): string | null
  path(): string
  now(): number
  later(fn: () => void, ms: number): void
}

export interface ErrorReporter {
  /** Note one error; `where` names the view that failed (ErrorBoundary's). Never throws. */
  capture(error: unknown, where?: string): void
  /** Send what is waiting now; `keepalive` lets the request outlive a closing page. */
  flush(keepalive?: boolean): Promise<void>
  /** What is waiting to go, for the tests. */
  waiting(): CleanReport[]
}

/** An error's message and stack, whatever was thrown. A rejection's reason is only ever read for its message, never its other fields. */
export function describeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    const name = error.name || 'Error'
    const message = !error.message ? name : error.message.startsWith(name) ? error.message : `${name}: ${error.message}`
    return { message, stack: typeof error.stack === 'string' ? error.stack : null }
  }
  if (typeof error === 'string') return { message: error, stack: null }
  const own = (error as { message?: unknown } | null)?.message
  if (typeof own === 'string' && own) return { message: own, stack: null }
  return { message: `A non-Error was thrown (${error === null ? 'null' : typeof error})`, stack: null }
}

/**
 * Which screen is up, from the page itself: a screen you go into (Settings,
 * the chat, Admin) or the tab that is current. Only those names, never text
 * from the page; anything else is "other".
 */
export function viewFromDom(doc: Pick<Document, 'querySelector'> = document): string | null {
  const name = doc.querySelector('.pushed-screen .pushed-head .view-title')?.textContent ?? doc.querySelector('nav.tabs [aria-current="page"] .tab-label')?.textContent ?? ''
  const v = name.trim().toLowerCase()
  return SCREENS.has(v) ? v : v ? 'other' : null
}

export function createErrorReporter(deps: ReporterDeps): ErrorReporter {
  let queue: CleanReport[] = []
  /** When each error last went into the queue. */
  const lastQueued = new Map<string, number>()
  let scheduled = false

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    deps.later(() => {
      scheduled = false
      void flush()
    }, FLUSH_DELAY_MS)
  }

  function capture(error: unknown, where?: string): void {
    try {
      if (!deps.online()) return
      const { message, stack } = describeError(error)
      if (IGNORED.some(re => re.test(message))) return
      const report = cleanReport({ message, stack, build: deps.build(), platform: deps.platform(), view: where ?? deps.view(), path: deps.path(), count: 1 })
      if (!report) return
      const now = deps.now()
      const last = lastQueued.get(report.fingerprint)
      if (last !== undefined && now - last < DEDUPE_MS) {
        const waiting = queue.find(r => r.fingerprint === report.fingerprint)
        if (waiting) waiting.count = Math.min(COUNT_MAX, waiting.count + 1)
        return
      }
      if (queue.length >= QUEUE_MAX) return
      if (lastQueued.size > 200) for (const [fp, at] of lastQueued) if (now - at >= DEDUPE_MS) lastQueued.delete(fp)
      lastQueued.set(report.fingerprint, now)
      queue.push(report)
      schedule()
    } catch {
      /* a reporter that throws would only report itself */
    }
  }

  async function flush(keepalive = false): Promise<void> {
    if (queue.length === 0) return
    const batch = queue.slice(0, BATCH_MAX)
    queue = queue.slice(BATCH_MAX)
    try {
      if (!deps.online() || !(await deps.signedIn())) {
        // dropped, all of it: nothing waits to go later
        queue = []
        return
      }
      await deps.send(batch, keepalive)
    } catch {
      /* one lost report is not worth another */
    } finally {
      if (queue.length) schedule()
    }
  }

  return { capture, flush, waiting: () => queue.map(r => ({ ...r })) }
}

/** The browser's own answers: the API, the session, the build stamp and the page. */
function browserDeps(): ReporterDeps {
  return {
    send: (reports, keepalive) =>
      apiFetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reports }), keepalive, timeoutMs: 10_000 }),
    signedIn: async () => {
      const sb = getSupabase()
      if (!sb) return false
      const { data } = await sb.auth.getSession()
      return !!data.session
    },
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    build: () => pageBuild(),
    platform: () => (Capacitor.getPlatform() === 'ios' ? 'ios' : 'web'),
    view: () => viewFromDom(),
    path: () => window.location.pathname,
    now: () => Date.now(),
    later: (fn, ms) => void window.setTimeout(fn, ms),
  }
}

let installed: ErrorReporter | null = null

/**
 * Listen for what React does not catch — an error thrown anywhere else, and a
 * promise nobody handled — and send what is waiting as the page goes away.
 * Once per page; main.tsx calls it before the app renders.
 */
export function installErrorReporting(deps: ReporterDeps = browserDeps(), target: Pick<Window, 'addEventListener'> = window): ErrorReporter {
  if (installed) return installed
  const reporter = createErrorReporter(deps)
  target.addEventListener('error', e => {
    const ev = e as ErrorEvent
    // an image or a script that did not load fires on its element, not here; nothing to say without either
    if (ev.error != null || ev.message) reporter.capture(ev.error ?? ev.message)
  })
  target.addEventListener('unhandledrejection', e => reporter.capture((e as PromiseRejectionEvent).reason))
  target.addEventListener('pagehide', () => void reporter.flush(true))
  installed = reporter
  return reporter
}

/** ErrorBoundary's hook: a view that failed to draw, by the name the boundary gives it. Nothing before installErrorReporting. */
export function reportRenderError(error: unknown, where?: string): void {
  installed?.capture(error, where)
}

/** Forget the installed reporter, so a test can install its own. */
export function resetErrorReporting(): void {
  installed = null
}
