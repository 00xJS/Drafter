import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MESSAGE_MAX, STACK_MAX, cleanPath, cleanReport, cleanView, fingerprintOf, scrubText, stripQueries } from '../../shared/errorreport.mjs'
import type { CleanReport } from '../../shared/errorreport.mjs'
import { ErrorBoundary } from '../components/ErrorBoundary'
import {
  BATCH_MAX,
  DEDUPE_MS,
  FLUSH_DELAY_MS,
  createErrorReporter,
  describeError,
  installErrorReporting,
  reportRenderError,
  resetErrorReporting,
  viewFromDom,
  type ReporterDeps,
} from '../errorreport'

// A crash on a device used to reach nobody: ErrorBoundary wrote it to that
// device's console, and nothing listened for an error thrown outside React or
// a promise nobody handled. The app now tells the site owner — with the
// error's own message and stack, the build, the platform and the screen, and
// never a record, a title or anything typed (shared/errorreport.mjs decides,
// on the device and again on the server).

const CHROME_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'title')",
  '    at TaskCard (https://drafterz.netlify.app/assets/Planner-Do0Ui_vC.js:12:3456)',
  '    at renderWithHooks (https://drafterz.netlify.app/assets/vendor-react-ebxS2RN4.js:1:999)',
].join('\n')

describe('what a report may carry', () => {
  it('cuts every query string and fragment, and keeps where in the file it happened', () => {
    expect(stripQueries('GET https://x.supabase.co/rest/v1/posts?select=*&token=abc failed')).toBe('GET https://x.supabase.co/rest/v1/posts failed')
    expect(stripQueries('at f (https://site/assets/a.js?v=2:10:20)')).toBe('at f (https://site/assets/a.js:10:20)')
    expect(stripQueries('capacitor://drafter/index.html#/tasks?open=t1')).toBe('capacitor://drafter/index.html')
  })

  it('takes out email addresses and long quoted text, which is somebody’s words, and keeps short code-like quotes', () => {
    const said = scrubText(`Unexpected token 'B', "Buy a present for Maria’s birthday on Friday" is not valid JSON; mail jo.smith+x@example.co.uk`, MESSAGE_MAX)
    expect(said).not.toContain('present')
    expect(said).not.toContain('jo.smith')
    expect(said).toContain("token 'B'")
    expect(said).toContain('<email>')
    expect(scrubText("Cannot read properties of undefined (reading 'title')", MESSAGE_MAX)).toBe("Cannot read properties of undefined (reading 'title')")
    // Safari's frames look like name@url, and are not email addresses
    expect(scrubText('render@https://drafterz.netlify.app/assets/index.js:1:2', STACK_MAX)).toBe('render@https://drafterz.netlify.app/assets/index.js:1:2')
  })

  it('caps the message at 500 characters and the stack at 4 KB', () => {
    const r = cleanReport({ message: 'x'.repeat(2000), stack: `${'at f (a.js:1:1)\n'.repeat(1000)}`, platform: 'web' })!
    expect(r.message).toHaveLength(MESSAGE_MAX)
    expect(r.stack!.length).toBeLessThanOrEqual(STACK_MAX)
    expect(cleanReport({ message: '   ' })).toBeNull()
    expect(cleanReport('boom')).toBeNull()
  })

  it('keeps only a path, never its query string, and only names a screen the app names', () => {
    expect(cleanPath('/oauth/authorize?client_id=x&state=y#frag')).toBe('/oauth/authorize')
    expect(cleanPath('https://evil.example/')).toBeNull()
    expect(cleanView('Home')).toBe('home')
    expect(cleanView('the task editor')).toBe('the task editor')
    expect(cleanView('Buy milk <script>')).toBe('other')
    expect(cleanView('')).toBeNull()
    const r = cleanReport({ message: 'boom', platform: 'android', build: 'abc 123!', count: 1e9 })!
    expect(r).toMatchObject({ platform: null, build: 'abc123', count: 1000 })
  })

  it('names one error the same way in every build, and two platforms or two messages apart', () => {
    const next = CHROME_STACK.replace('Planner-Do0Ui_vC.js:12:3456', 'Planner-Xy12Ab34.js:14:77')
    const msg = "TypeError: Cannot read properties of undefined (reading 'title')"
    expect(fingerprintOf({ message: msg, stack: CHROME_STACK, platform: 'web' })).toBe(fingerprintOf({ message: msg, stack: next, platform: 'web' }))
    expect(fingerprintOf({ message: msg, stack: CHROME_STACK, platform: 'web' })).not.toBe(fingerprintOf({ message: msg, stack: CHROME_STACK, platform: 'ios' }))
    expect(fingerprintOf({ message: msg, stack: CHROME_STACK, platform: 'web' })).not.toBe(fingerprintOf({ message: 'RangeError: Invalid time value', stack: CHROME_STACK, platform: 'web' }))
    // the numbers that change each time are not part of the name
    expect(fingerprintOf({ message: 'Request timed out after 30012 ms' })).toBe(fingerprintOf({ message: 'Request timed out after 30187 ms' }))
    expect(fingerprintOf({ message: 'boom' })).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('whatever was thrown', () => {
  it('reads an Error by its name and message, a string as it is, and anything else by its type alone', () => {
    expect(describeError(new TypeError('x is undefined'))).toMatchObject({ message: 'TypeError: x is undefined' })
    expect(describeError(new Error(''))).toMatchObject({ message: 'Error' })
    expect(describeError('offline')).toEqual({ message: 'offline', stack: null })
    // a rejection's other fields (a row's details, say) are never read
    expect(describeError({ message: 'duplicate key', details: 'Key (title)=(Buy milk)' })).toEqual({ message: 'duplicate key', stack: null })
    expect(describeError(undefined)).toEqual({ message: 'A non-Error was thrown (undefined)', stack: null })
    expect(describeError(null)).toEqual({ message: 'A non-Error was thrown (null)', stack: null })
  })
})

/** A reporter over fakes: a clock, timers run by hand, and what was sent. */
function harness(over: Partial<ReporterDeps> = {}) {
  const sent: { reports: CleanReport[]; keepalive: boolean }[] = []
  const timers: (() => void)[] = []
  const world = { now: Date.parse('2026-09-22T10:00:00.000Z'), online: true, signedIn: true, view: 'home' as string | null }
  const deps: ReporterDeps = {
    send: async (reports, keepalive) => {
      sent.push({ reports: JSON.parse(JSON.stringify(reports)), keepalive })
    },
    signedIn: async () => world.signedIn,
    online: () => world.online,
    build: () => '6ab15c99',
    platform: () => 'web',
    view: () => world.view,
    path: () => '/',
    now: () => world.now,
    later: fn => void timers.push(fn),
    ...over,
  }
  const reporter = createErrorReporter(deps)
  /** Run the timers that are due, as FLUSH_DELAY_MS going by would. */
  const tick = async () => {
    for (const fn of timers.splice(0)) fn()
    await new Promise(r => setTimeout(r, 0))
  }
  return { reporter, sent, world, tick, timers }
}

describe('the reporter', () => {
  it('waits a moment and sends a burst as one request, with the build, platform, screen and path', async () => {
    const { reporter, sent, tick, timers } = harness()
    reporter.capture(new TypeError('a is undefined'))
    reporter.capture(new RangeError('Invalid time value'))
    expect(sent).toHaveLength(0)
    expect(timers).toHaveLength(1)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].reports.map(r => r.message)).toEqual(['TypeError: a is undefined', 'RangeError: Invalid time value'])
    expect(sent[0].reports[0]).toMatchObject({ build: '6ab15c99', platform: 'web', view: 'home', path: '/', count: 1 })
    expect(sent[0].keepalive).toBe(false)
    expect(FLUSH_DELAY_MS).toBeGreaterThan(0)
  })

  it('counts the same error again on the report still waiting, and sends nothing more for ten minutes', async () => {
    const { reporter, sent, world, tick } = harness()
    const again = () => reporter.capture(new TypeError('a is undefined'))
    again()
    again()
    again()
    await tick()
    expect(sent[0].reports).toHaveLength(1)
    expect(sent[0].reports[0].count).toBe(3)
    world.now += DEDUPE_MS - 1
    again()
    await tick()
    expect(sent).toHaveLength(1)
    world.now += 1
    again()
    await tick()
    expect(sent).toHaveLength(2)
    expect(sent[1].reports[0].count).toBe(1)
  })

  it('sends at most ten a request, and the rest right after', async () => {
    const { reporter, sent, tick } = harness()
    for (let i = 0; i < 14; i++) reporter.capture(new Error(`distinct failure ${String.fromCharCode(97 + i)}`))
    await tick()
    expect(sent.map(s => s.reports.length)).toEqual([BATCH_MAX])
    await tick()
    expect(sent.map(s => s.reports.length)).toEqual([BATCH_MAX, 4])
  })

  it('drops what happens offline, and everything waiting once it is offline or signed out', async () => {
    const offline = harness()
    offline.world.online = false
    offline.reporter.capture(new Error('while offline'))
    expect(offline.reporter.waiting()).toEqual([])

    const signedOut = harness()
    signedOut.reporter.capture(new Error('before signing out'))
    signedOut.world.signedIn = false
    await signedOut.tick()
    expect(signedOut.sent).toEqual([])
    expect(signedOut.reporter.waiting()).toEqual([])
  })

  it('names the view that failed when a boundary says which, and otherwise the screen that is up', async () => {
    const { reporter, sent, world, tick } = harness()
    reporter.capture(new Error('render failed'), 'the task editor')
    world.view = null
    reporter.capture(new Error('before any screen'))
    await tick()
    expect(sent[0].reports.map(r => r.view)).toEqual(['the task editor', null])
  })

  it('never sends what the user wrote', async () => {
    const { reporter, sent, tick } = harness()
    reporter.capture(new Error('Could not save "Tell Maria about the surprise party on Saturday" for jo@example.com'))
    reporter.capture({ message: 'insert failed', details: 'Key (title)=(Tell Maria about the surprise party)' })
    await tick()
    const wire = JSON.stringify(sent)
    expect(wire).not.toMatch(/surprise|Maria|jo@example/)
  })

  it('ignores browser noise, and never throws — not even when sending does', async () => {
    const { reporter, sent, tick } = harness({
      send: async () => {
        throw new Error('network down')
      },
    })
    reporter.capture(new Error('ResizeObserver loop completed with undelivered notifications.'))
    reporter.capture('Script error.')
    expect(reporter.waiting()).toEqual([])
    reporter.capture(new Error('real'))
    await expect(tick()).resolves.toBeUndefined()
    expect(sent).toEqual([])
    const broken = harness({
      build: () => {
        throw new Error('no meta')
      },
    })
    expect(() => broken.reporter.capture(new Error('x'))).not.toThrow()
  })
})

describe('installed on the page', () => {
  type Listener = (e: Event) => void
  type Sent = { reports: CleanReport[]; keepalive: boolean }[]
  let listeners: Map<string, Listener>
  const target = { addEventListener: (type: string, fn: Listener) => void listeners.set(type, fn) } as unknown as Pick<Window, 'addEventListener'>
  /** Deps that send into `sent`; nothing flushes until the page goes away. */
  const into = (sent: Sent, over: Partial<ReporterDeps> = {}): ReporterDeps => ({
    send: async (reports, keepalive) => void sent.push({ reports: JSON.parse(JSON.stringify(reports)), keepalive }),
    signedIn: async () => true,
    online: () => true,
    build: () => 'b1',
    platform: () => 'web',
    view: () => 'home',
    path: () => '/',
    now: () => 0,
    later: () => {},
    ...over,
  })

  beforeEach(() => {
    listeners = new Map()
    resetErrorReporting()
  })
  afterEach(() => resetErrorReporting())

  it('hears an uncaught error and an unhandled rejection, and sends what waits as the page goes away', async () => {
    const sent: Sent = []
    installErrorReporting(into(sent, { platform: () => 'ios', view: () => 'calendar' }), target)
    listeners.get('error')!({ error: new TypeError('boom'), message: 'Uncaught TypeError: boom' } as unknown as Event)
    listeners.get('unhandledrejection')!({ reason: new Error('fetch failed') } as unknown as Event)
    // an image that did not load says nothing here
    listeners.get('error')!({ error: null, message: '' } as unknown as Event)
    listeners.get('pagehide')!(new Event('pagehide'))
    await new Promise(r => setTimeout(r, 0))
    expect(sent).toHaveLength(1)
    expect(sent[0].keepalive).toBe(true)
    expect(sent[0].reports.map(r => [r.message, r.platform, r.view])).toEqual([
      ['TypeError: boom', 'ios', 'calendar'],
      ['Error: fetch failed', 'ios', 'calendar'],
    ])
  })

  it('is ErrorBoundary’s hook: a view that fails to draw is reported under the boundary’s name', () => {
    const reporter = installErrorReporting(into([]), target)
    // once per page: a second install hands back the first
    expect(installErrorReporting(into([]), target)).toBe(reporter)
    new ErrorBoundary({ where: 'Tasks', children: null }).componentDidCatch(new Error('TDZ'))
    reportRenderError(new Error('from a layer'), 'the event editor')
    expect(reporter.waiting().map(r => [r.message, r.view])).toEqual([
      ['Error: TDZ', 'tasks'],
      ['Error: from a layer', 'the event editor'],
    ])
  })

  it('reports nothing before it is installed', () => {
    expect(() => reportRenderError(new Error('early'))).not.toThrow()
  })
})

describe('which screen is up', () => {
  const doc = (found: Record<string, string>) => ({ querySelector: (sel: string) => (sel in found ? { textContent: found[sel] } : null) }) as unknown as Pick<Document, 'querySelector'>
  const PUSHED = '.pushed-screen .pushed-head .view-title'
  const TAB = 'nav.tabs [aria-current="page"] .tab-label'

  it('is a screen you went into, else the current tab, and never other words from the page', () => {
    expect(viewFromDom(doc({ [PUSHED]: 'Settings', [TAB]: 'Home' }))).toBe('settings')
    expect(viewFromDom(doc({ [TAB]: 'Insights' }))).toBe('insights')
    expect(viewFromDom(doc({ [TAB]: 'Groceries for Maria' }))).toBe('other')
    expect(viewFromDom(doc({}))).toBeNull()
  })
})
