import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FRAMES_MAX, MASK, MESSAGE_MAX, STACK_MAX, cleanPath, cleanReport, cleanView, fingerprintOf, scrubMessage, scrubStack, stripQueries } from '../../shared/errorreport.mts'
import type { CleanReport } from '../../shared/errorreport.mts'
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
// never a record, a title or anything typed (shared/errorreport.mts decides,
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

  it('takes out email addresses and quoted text, which is somebody’s words, and keeps a quoted token or property', () => {
    const said = scrubMessage(`Unexpected token 'B', "Buy a present for Maria’s birthday on Friday" is not valid JSON; mail jo.smith+x@example.co.uk`, MESSAGE_MAX)
    expect(said).not.toContain('present')
    expect(said).not.toContain('jo.smith')
    expect(said).toContain("token 'B'")
    expect(said).toContain('<email>')
    expect(scrubMessage("Cannot read properties of undefined (reading 'title')", MESSAGE_MAX)).toBe("Cannot read properties of undefined (reading 'title')")
    // Safari's frames look like name@url, and are not email addresses
    expect(scrubStack('render@https://drafterz.netlify.app/assets/index.js:1:2', STACK_MAX)).toBe('at /assets/index.js:1:2')
  })

  it('caps the message at 500 characters and the stack at 4 KB', () => {
    const r = cleanReport({ message: `Error: ${'failed to load '.repeat(100)}`, stack: `${'at f (a.js:1:1)\n'.repeat(1000)}`, platform: 'web' })!
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

describe('what a message may say', () => {
  // A throw that interpolates a record puts it in the message whether or not
  // it quotes it, so the rule is about words: the words error messages are
  // made of and whatever reads as code stay, and every other word, number, id,
  // date or address is masked. These are the shapes the app's own throws and
  // the server's answers take, with what must not survive them.
  const survives = (message: string, ...private_: string[]) => {
    const kept = scrubMessage(message)
    for (const bit of private_) expect(kept, `"${bit}" survived in ${kept}`).not.toContain(bit)
    return kept
  }

  it('masks a task title interpolated without quotes, and keeps the message around it', () => {
    expect(survives('Error: Could not save Pick up dry cleaning before Friday', 'Pick', 'dry', 'cleaning', 'Friday')).toBe(`Error: Could not save ${MASK} up ${MASK} before ${MASK}`)
    expect(survives('Error: Renew passport could not be moved to Done', 'Renew', 'passport', 'moved')).toBe(`Error: ${MASK} could not be ${MASK} to Done`)
    // one lower-case word is a title too, when it is not a word errors use
    expect(survives('Error: dentist', 'dentist')).toBe(`Error: ${MASK}`)
    expect(survives('Error: BUY MILK', 'BUY', 'MILK')).toBe(`Error: ${MASK}`)
  })

  it('masks a person’s name, capitalised or not, in quotes or out', () => {
    expect(survives('Error: No place found for Maria Gonzalez', 'Maria', 'Gonzalez')).toBe(`Error: No place found for ${MASK}`)
    expect(survives("TypeError: Cannot read properties of undefined (reading 'Maria')", 'Maria')).toBe(`TypeError: Cannot read properties of undefined (reading '${MASK}')`)
    expect(survives('Error: José and Zoë', 'José', 'Zoë')).toBe(`Error: ${MASK} and ${MASK}`)
    expect(survives('Error: invite for “Maria Gonzalez” expired', 'Maria', 'Gonzalez')).toBe(`Error: invite for “${MASK}” expired`)
  })

  it('takes a phone number, a date and an email address out whole, and cuts other numbers to two digits', () => {
    expect(survives('Error: Invalid phone +1 (602) 555-0142', '602', '555', '0142')).toBe('Error: Invalid phone <number>')
    expect(survives('Error: call 602.555.0142 or 555-0142', '602', '555', '0142')).toBe('Error: call <number> or <number>')
    expect(survives('Error: Journal 2026-09-22T10:30:00.000Z failed', '2026', '09-22')).toBe('Error: Journal <date> failed')
    expect(survives('Error: no account for jo.smith@example.co.uk', 'jo.smith', 'example')).toBe('Error: no account for <email>')
    expect(scrubMessage('Request timed out after 30012 ms')).toBe(`Request timed out after 30${MASK} ms`)
    // a status, a position or a version stays
    expect(scrubMessage('Error: status 404 at position 12, line 1 column 13, build 1.1.2')).toBe('Error: status 404 at position 12, line 1 column 13, build 1.1.2')
  })

  it('keeps an id’s first four characters, and no more', () => {
    expect(survives('Error: 3f2b8c1e-1111-4a4a-9b9b-0123456789ab is not on this device', '8c1e', '0123456789ab')).toBe(`Error: 3f2b${MASK} is not on this device`)
    expect(survives('Error: item a1b2c3d4e5f6 missing', 'c3d4e5f6')).toBe(`Error: item a1b2${MASK} missing`)
    // a head that would read as a word the next time round goes too
    expect(survives('Error: token eyJhbGciOiJIUzI1NiJ9 expired', 'eyJh', 'IUzI1NiJ9')).toBe(`Error: token ${MASK} expired`)
  })

  it('keeps a URL’s host and masks what its path says: a recipe’s name, an address, a private token', () => {
    const ics = survives(
      'Error: Could not read https://calendar.google.com/calendar/ical/joseph%40gmail.com/private-0123456789abcdef0123/basic.ics?ctz=America/Phoenix',
      'joseph',
      'gmail',
      '0123456789abcdef',
      'Phoenix',
    )
    expect(ics).toMatch(/^Error: Could not read https:\/\/calendar\.google\.com\//)
    expect(survives('Couldn’t import https://www.allrecipes.com/recipe/12345/grandmas-chocolate-chip-muffins/', 'grandma', 'chocolate', 'muffins', '12345')).toMatch(
      /^Couldn’t import https:\/\/www\.allrecipes\.com\/recipe\//,
    )
    // the app's own chunks, the API and the database's endpoints read as they are
    expect(scrubMessage('Failed to fetch dynamically imported module: https://drafterz.netlify.app/assets/Settings-B-zFXg-i.js')).toBe(
      'Failed to fetch dynamically imported module: https://drafterz.netlify.app/assets/Settings-B-zFXg-i.js',
    )
    expect(scrubMessage('POST https://x.supabase.co/rest/v1/rpc/sync_posts failed: 401')).toBe('POST https://x.supabase.co/rest/v1/rpc/sync_posts failed: 401')
  })

  it('keeps what error messages are made of: the class, their words and code', () => {
    for (const message of [
      "TypeError: Cannot read properties of undefined (reading 'title')",
      "Failed to execute 'put' on 'IDBObjectStore': Evaluating the object store's key path did not yield a value.",
      'TypeError: $(t).filter is not a function',
      'NotAllowedError: The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.',
      'new row violates row-level security policy for table "posts"',
      'Drafter’s server could not be reached — try again in a moment.',
      'unionPlanes: masks of different sizes',
      'A non-Error was thrown (undefined)',
      'JWT expired',
      `SyntaxError: Unexpected token '<', "${MASK}"... is not valid JSON`,
    ]) {
      expect(scrubMessage(message)).toBe(message)
    }
  })

  it('changes nothing the second time, so the server’s pass agrees with the app’s', () => {
    for (const message of [
      'Error: Could not save Pick up dry cleaning before Friday',
      'Error: Invalid phone +1 (602) 555-0142 for jo@example.com on 2026-09-22',
      'Error: Could not read https://calendar.google.com/calendar/ical/joseph%40gmail.com/private-0123456789abcdef0123/basic.ics',
      'household_members 409: {"code":"23505","details":"Key (household_id, user_id)=(00000000-0000-0000-0000-0000000000f1, 3f2b8c1e-1111-4a4a-9b9b-0123456789ab)"}',
      'Request timed out after 30012 ms; retry 4096 of 0123',
      "TypeError: Cannot read properties of undefined (reading 'birthday')",
    ]) {
      const once = scrubMessage(message)
      expect(scrubMessage(once)).toBe(once)
    }
  })
})

describe('what a stack may say', () => {
  const CHROME = [
    "TypeError: Cannot read properties of undefined (reading 'Buy milk')",
    '    at TaskCard (https://drafterz.netlify.app/assets/Planner-Do0Ui_vC.js:12:3456)',
    '    at async saveTitle (https://drafterz.netlify.app/assets/index-C4YVs1Io.js:1:99)',
    '    at Array.map (<anonymous>)',
    '    at eval (eval at <anonymous> (https://x.example/a.js:1:2), <anonymous>:1:1)',
  ].join('\n')
  const SAFARI = [
    'render@capacitor://drafter/assets/index-C4YVs1Io.js:1:2',
    'global code@https://drafterz.netlify.app/?task=Buy%20milk&token=abc:3:4',
    '[native code]',
    '@blob:https://drafterz.netlify.app/3f2b8c1e-1111-4a4a-9b9b-0123456789ab:10:20',
  ].join('\n')

  it('is each frame’s file, line and column: no message, no function names, no origin, no query', () => {
    expect(scrubStack(CHROME)).toBe(['at /assets/Planner-Do0Ui_vC.js:12:3456', 'at /assets/index-C4YVs1Io.js:1:99'].join('\n'))
    expect(scrubStack(SAFARI)).toBe(['at /assets/index-C4YVs1Io.js:1:2', 'at /:3:4', 'at blob:10:20'].join('\n'))
    const kept = `${scrubStack(CHROME)}\n${scrubStack(SAFARI)}`
    expect(kept).not.toMatch(/Buy|milk|TaskCard|saveTitle|token|drafterz|3f2b8c1e|TypeError/)
  })

  it('keeps at most twenty frames, changes nothing the second time, and still names the error by its top frame', () => {
    const deep = Array.from({ length: 50 }, (_, i) => `    at f${i} (https://site/assets/a-${i}.js:${i + 1}:1)`).join('\n')
    expect(scrubStack(deep).split('\n')).toHaveLength(FRAMES_MAX)
    for (const stack of [CHROME, SAFARI, deep]) expect(scrubStack(scrubStack(stack))).toBe(scrubStack(stack))
    const msg = "TypeError: Cannot read properties of undefined (reading 'title')"
    const next = CHROME.replace('Planner-Do0Ui_vC.js:12:3456', 'Planner-Xy12Ab34.js:14:77')
    expect(cleanReport({ message: msg, stack: CHROME, platform: 'web' })!.fingerprint).toBe(cleanReport({ message: msg, stack: next, platform: 'web' })!.fingerprint)
    expect(scrubStack(null)).toBe('')
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
    // and not when the code that threw put it in its message unquoted
    reporter.capture(new Error('Could not save Pick up dry cleaning before Friday for Maria Gonzalez, 602-555-0142'))
    await tick()
    const wire = JSON.stringify(sent)
    expect(wire).not.toMatch(/surprise|Maria|jo@example|Pick|dry|cleaning|Friday|Gonzalez|555|0142/)
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
    listeners.get('error')!({ error: new TypeError('x is undefined'), message: 'Uncaught TypeError: x is undefined' } as unknown as Event)
    listeners.get('unhandledrejection')!({ reason: new Error('fetch failed') } as unknown as Event)
    // an image that did not load says nothing here
    listeners.get('error')!({ error: null, message: '' } as unknown as Event)
    listeners.get('pagehide')!(new Event('pagehide'))
    await new Promise(r => setTimeout(r, 0))
    expect(sent).toHaveLength(1)
    expect(sent[0].keepalive).toBe(true)
    expect(sent[0].reports.map(r => [r.message, r.platform, r.view])).toEqual([
      ['TypeError: x is undefined', 'ios', 'calendar'],
      ['Error: fetch failed', 'ios', 'calendar'],
    ])
  })

  it('is ErrorBoundary’s hook: a view that fails to draw is reported under the boundary’s name', () => {
    const reporter = installErrorReporting(into([]), target)
    // once per page: a second install hands back the first
    expect(installErrorReporting(into([]), target)).toBe(reporter)
    new ErrorBoundary({ where: 'Tasks', children: null }).componentDidCatch(new Error('TDZ'))
    reportRenderError(new Error('from a sheet'), 'the event editor')
    expect(reporter.waiting().map(r => [r.message, r.view])).toEqual([
      ['Error: TDZ', 'tasks'],
      ['Error: from a sheet', 'the event editor'],
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
