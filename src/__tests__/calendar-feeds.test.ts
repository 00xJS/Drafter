import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEED_LIMITS, FeedError, createFeedCache, feedUrl, fetchFeed } from '../../netlify/functions/lib/icsfeed.mjs'
import type { FeedCache } from '../../netlify/functions/lib/icsfeed.mjs'
import type { Resolver, Transport, TransportResponse } from '../../netlify/functions/lib/safefetch.mjs'
import { world } from './cal-world'

// Subscribed calendars (ICS feeds) are fetched by the server, from an address
// someone pasted. It used to filter the host with a regex and fetch with
// redirect: 'follow', so the cloud's metadata address (169.254.169.254), IPv6
// and CGNAT forms of it, a name resolving to a private network and any
// redirect all got through, and the whole body was read before its 4 MB check.
// Now a feed goes through the recipe importer's transport (lib/safefetch.mjs),
// with its resolver and its connection faked here as the importer's tests fake
// them: nothing below touches the network. And a feed fetched a moment ago is
// answered from memory, or asked for again conditionally (lib/icsfeed.mjs).

// Resolved at run time, not by tsc: a .d.mts beside a function would ship as a function.
const CALENDARS_FUNCTION = '../../netlify/functions/calendars.mjs'

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:School',
  'BEGIN:VEVENT',
  'UID:sports@school',
  'SUMMARY:Sports day',
  'DTSTART;VALUE=DATE:20260918',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

type Calls = { url: string; address: string; headers: Record<string, string> }[]

async function* chunks(...parts: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield typeof p === 'string' ? Buffer.from(p) : p
}

const ics = (body: string | Buffer = FEED, headers: Record<string, string> = {}): TransportResponse => ({ status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', ...headers }, body: chunks(body) })
const redirect = (location: string, status = 302): TransportResponse => ({ status, headers: { location }, body: chunks('') })

function resolver(table: Record<string, string[]>, asked: string[] = []): Resolver {
  return async host => {
    asked.push(host)
    const found = table[host]
    if (!found) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    return found.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

function transport(routes: Record<string, (headers: Record<string, string>) => TransportResponse | Promise<TransportResponse>>, calls: Calls = []): Transport {
  return async ({ url, address, headers }) => {
    calls.push({ url: url.toString(), address, headers })
    const route = routes[url.toString()]
    if (!route) throw new Error(`no route for ${url}`)
    return route(headers)
  }
}

const PUBLIC = { 'school.example.com': ['93.184.216.34'], 'cdn.example.org': ['2606:4700::6810:84e5'] }

// ---- the endpoint -------------------------------------------------------------------

describe('/api/calendars fetches a feed only from the public internet', () => {
  beforeEach(() => {
    world({ sessions: { 'session-1': { id: 'u-feeds', email: 'me@example.test' } } })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function ask(sources: { id: string; url: string }[], opts: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { calendarsHandler } = (await import(/* @vite-ignore */ CALENDARS_FUNCTION)) as {
      calendarsHandler(opts: Record<string, unknown>): (req: Request) => Promise<Response>
    }
    const res = await calendarsHandler({ cache: createFeedCache(), ...opts })(
      new Request('https://drafterz.netlify.app/api/calendars', {
        method: 'POST',
        headers: { authorization: 'Bearer session-1', 'content-type': 'application/json' },
        body: JSON.stringify({ sources, from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', ...extra }),
      }),
    )
    expect(res.status).toBe(200)
    return (await res.json()) as { events: { title: string; sourceId: string; start: string }[]; errors: Record<string, string>; names: Record<string, string> }
  }

  it('reads a public feed from the address it checked, webcal:// as https://', async () => {
    const calls: Calls = []
    const body = await ask([{ id: 's1', url: 'webcal://school.example.com/cal.ics' }], {
      resolve: resolver(PUBLIC),
      transport: transport({ 'https://school.example.com/cal.ics': () => ics() }, calls),
    })
    expect(body.errors).toEqual({})
    expect(body.names).toEqual({ s1: 'School' })
    expect(body.events.map(e => [e.title, e.sourceId])).toEqual([['Sports day', 's1']])
    expect(calls.map(c => [c.url, c.address])).toEqual([['https://school.example.com/cal.ics', '93.184.216.34']])
  })

  it('refuses the metadata address in every spelling, IPv6 and CGNAT included, without asking DNS or connecting', async () => {
    const asked: string[] = []
    const calls: Calls = []
    const links = [
      'http://169.254.169.254/latest/meta-data/',
      'webcal://169.254.169.254/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/latest/',
      'http://[::ffff:a9fe:a9fe]/latest/',
      'http://[fd00:ec2::254]/latest/',
      'http://100.100.100.200/latest/meta-data/',
      'http://100.64.0.1/cal.ics',
      'http://2130706433/cal.ics',
      'http://0x7f.1/cal.ics',
      'http://[::1]/cal.ics',
    ]
    const body = await ask(
      links.map((url, i) => ({ id: `s${i}`, url })),
      { resolve: resolver({}, asked), transport: transport({}, calls) },
    )
    for (let i = 0; i < links.length; i++) expect(body.errors[`s${i}`], links[i]).toMatch(/isn’t on the public internet/)
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses a public-looking name that resolves to a private address, before any request', async () => {
    const calls: Calls = []
    const body = await ask([{ id: 's1', url: 'https://intranet.example.com/cal.ics' }], {
      resolve: resolver({ 'intranet.example.com': ['93.184.216.34', '10.0.0.5'] }),
      transport: transport({ 'https://intranet.example.com/cal.ics': () => ics() }, calls),
    })
    expect(body.errors.s1).toMatch(/isn’t on the public internet/)
    expect(calls).toEqual([])
  })

  it('checks every redirect: one to the metadata address, or to a name that resolves privately, is never followed', async () => {
    for (const location of ['http://169.254.169.254/latest/meta-data/iam/', 'http://rebind.example.net/admin', 'http://[fd00:ec2::254]/']) {
      const calls: Calls = []
      const body = await ask([{ id: 's1', url: 'https://school.example.com/cal.ics' }], {
        resolve: resolver({ ...PUBLIC, 'rebind.example.net': ['192.168.0.10'] }),
        transport: transport({ 'https://school.example.com/cal.ics': () => redirect(location) }, calls),
      })
      expect(body.errors.s1, location).toMatch(/isn’t on the public internet/)
      expect(calls, location).toHaveLength(1)
    }
  })

  it('follows a redirect to another public host, checking that host too', async () => {
    const asked: string[] = []
    const calls: Calls = []
    const body = await ask([{ id: 's1', url: 'https://school.example.com/cal.ics' }], {
      resolve: resolver(PUBLIC, asked),
      transport: transport({ 'https://school.example.com/cal.ics': () => redirect('https://cdn.example.org/feeds/9.ics', 301), 'https://cdn.example.org/feeds/9.ics': () => ics() }, calls),
    })
    expect(body.errors).toEqual({})
    expect(body.events.map(e => e.title)).toEqual(['Sports day'])
    expect(asked).toEqual(['school.example.com', 'cdn.example.org'])
    expect(calls.map(c => c.address)).toEqual(['93.184.216.34', '2606:4700::6810:84e5'])
  })

  it('stops reading a feed the moment it passes 4 MB, and lets the stream go', async () => {
    let yielded = 0
    let finished = false
    const endless = (async function* () {
      try {
        for (;;) {
          yielded++
          yield Buffer.alloc(64 * 1024, 65)
        }
      } finally {
        finished = true
      }
    })()
    const body = await ask([{ id: 's1', url: 'https://school.example.com/cal.ics' }], {
      resolve: resolver(PUBLIC),
      transport: transport({ 'https://school.example.com/cal.ics': () => ({ status: 200, headers: { 'content-type': 'text/calendar' }, body: endless }) }),
    })
    expect(body.errors.s1).toBe('calendar is too large (4 MB max)')
    expect(yielded).toBe(FEED_LIMITS.maxBytes / (64 * 1024) + 1)
    await new Promise(r => setTimeout(r, 0))
    expect(finished).toBe(true)
  })

  it('refuses a feed that says it is too big, without reading it', async () => {
    let read = false
    const body = (async function* () {
      read = true
      yield Buffer.from(FEED)
    })()
    const answer = await ask([{ id: 's1', url: 'https://school.example.com/cal.ics' }], {
      resolve: resolver(PUBLIC),
      transport: transport({ 'https://school.example.com/cal.ics': () => ({ status: 200, headers: { 'content-type': 'text/calendar', 'content-length': String(5 * 1024 * 1024) }, body }) }),
    })
    expect(answer.errors.s1).toBe('calendar is too large (4 MB max)')
    expect(read).toBe(false)
  })

  it('gives up on a feed that never answers', async () => {
    const body = await ask([{ id: 's1', url: 'https://school.example.com/cal.ics' }], {
      resolve: resolver(PUBLIC),
      timeoutMs: 30,
      transport: transport({ 'https://school.example.com/cal.ics': () => new Promise<TransportResponse>(() => {}) }),
    })
    expect(body.errors.s1).toBe('timed out fetching the calendar')
  })

  it('names what went wrong: a page that is not a calendar, a server error, a port no web page uses, nonsense', async () => {
    const body = await ask(
      [
        { id: 'page', url: 'https://school.example.com/page' },
        { id: 'gone', url: 'https://school.example.com/gone.ics' },
        { id: 'port', url: 'https://school.example.com:6379/cal.ics' },
        { id: 'file', url: 'file:///etc/passwd' },
        { id: 'nonsense', url: 'not a link' },
      ],
      {
        resolve: resolver(PUBLIC),
        transport: transport({
          'https://school.example.com/page': () => ics('<html><body>Hello</body></html>', { 'content-type': 'text/html' }),
          'https://school.example.com/gone.ics': () => ({ status: 404, headers: {}, body: chunks('nope') }),
        }),
      },
    )
    expect(body.errors).toEqual({
      page: 'not an iCalendar (.ics) feed',
      gone: 'The calendar’s server answered 404.',
      port: 'That address asks for a port Drafter doesn’t open.',
      file: 'not a valid https:// or webcal:// address',
      nonsense: 'not a valid https:// or webcal:// address',
    })
  })

  it('reads a time the feed gives no zone on the reader’s own clock, the zone the app sends', async () => {
    const floating = FEED.replace('DTSTART;VALUE=DATE:20260918', 'DTSTART:20260918T090000')
    const opts = { resolve: resolver(PUBLIC), transport: transport({ 'https://school.example.com/cal.ics': () => ics(floating) }) }
    const sources = [{ id: 's1', url: 'https://school.example.com/cal.ics' }]
    expect((await ask(sources, opts, { tz: 'America/Phoenix' })).events.map(e => e.start)).toEqual(['2026-09-18T16:00:00.000Z'])
    // a zone that is not one reads as none: UTC, as before
    expect((await ask(sources, opts, { tz: 'Mars/Olympus_Mons' })).events.map(e => e.start)).toEqual(['2026-09-18T09:00:00.000Z'])
  })

  it('answers a feed asked for again a moment later from memory, and asks its server on a pull-to-refresh', async () => {
    const calls: Calls = []
    const opts = {
      cache: createFeedCache(),
      resolve: resolver(PUBLIC),
      transport: transport({ 'https://school.example.com/cal.ics': () => ics(FEED, { etag: '"v1"' }) }, calls),
    }
    const sources = [{ id: 's1', url: 'https://school.example.com/cal.ics' }]
    expect((await ask(sources, opts)).events).toHaveLength(1)
    expect((await ask(sources, opts)).events).toHaveLength(1)
    expect(calls).toHaveLength(1)
    // the pull-down: asked again, conditionally
    expect((await ask(sources, opts, { fresh: true })).events).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[1].headers['if-none-match']).toBe('"v1"')
  })
})

// ---- the cache ----------------------------------------------------------------------

describe('fetchFeed: a copy for a few minutes, then a conditional GET', () => {
  const URL_ = 'https://school.example.com/cal.ics'
  let clock = 0
  let cache: FeedCache
  const now = () => clock
  beforeEach(() => {
    clock = Date.parse('2026-09-23T08:00:00Z')
    cache = createFeedCache()
  })

  it('from memory while fresh; after that, with the validators the server gave, and a 304 keeps the copy', async () => {
    const calls: Calls = []
    const answers: ((headers: Record<string, string>) => TransportResponse)[] = [
      () => ics(FEED, { etag: '"v1"', 'last-modified': 'Tue, 22 Sep 2026 10:00:00 GMT' }),
      () => ({ status: 304, headers: {}, body: chunks('') }),
    ]
    const opts = { cache, now, resolve: resolver(PUBLIC), transport: transport({ [URL_]: h => answers.shift()!(h) }, calls) }
    expect(await fetchFeed(feedUrl(URL_), opts)).toEqual({ text: FEED, from: 'network' })
    clock += FEED_LIMITS.freshMs - 1
    expect(await fetchFeed(feedUrl(URL_), opts)).toEqual({ text: FEED, from: 'memory' })
    expect(calls).toHaveLength(1)
    clock += 2
    expect(await fetchFeed(feedUrl(URL_), opts)).toEqual({ text: FEED, from: 'revalidated' })
    expect(calls[1].headers).toMatchObject({ 'if-none-match': '"v1"', 'if-modified-since': 'Tue, 22 Sep 2026 10:00:00 GMT' })
    // the 304 made it fresh again
    clock += 1000
    expect((await fetchFeed(feedUrl(URL_), opts)).from).toBe('memory')
    expect(calls).toHaveLength(2)
  })

  it('a feed that changed replaces the copy, and its new validator is the one sent next', async () => {
    const calls: Calls = []
    const changed = FEED.replace('Sports day', 'Sports day (moved)')
    const answers = [() => ics(FEED, { etag: '"v1"' }), () => ics(changed, { etag: '"v2"' }), () => ({ status: 304, headers: {}, body: chunks('') })]
    const opts = { cache, now, resolve: resolver(PUBLIC), transport: transport({ [URL_]: () => answers.shift()!() }, calls) }
    await fetchFeed(feedUrl(URL_), opts)
    expect(await fetchFeed(feedUrl(URL_), { ...opts, fresh: true })).toEqual({ text: changed, from: 'network' })
    expect(await fetchFeed(feedUrl(URL_), { ...opts, fresh: true })).toEqual({ text: changed, from: 'revalidated' })
    expect(calls.map(c => c.headers['if-none-match'])).toEqual([undefined, '"v1"', '"v2"'])
  })

  it('never keeps what failed: a server error is said, and the next ask goes to the server', async () => {
    const calls: Calls = []
    const answers = [() => ({ status: 503, headers: {}, body: chunks('busy') }), () => ics()]
    const opts = { cache, now, resolve: resolver(PUBLIC), transport: transport({ [URL_]: () => answers.shift()!() }, calls) }
    await expect(fetchFeed(feedUrl(URL_), opts)).rejects.toThrow(FeedError)
    expect((await fetchFeed(feedUrl(URL_), opts)).from).toBe('network')
    expect(calls).toHaveLength(2)
  })

  it('holds to its size, least recently used out first', () => {
    const small = createFeedCache({ maxBytes: 100 })
    const entry = (text: string) => ({ text, etag: null, lastModified: null, checkedAt: 0, bytes: 40 })
    small.set('a', entry('a'))
    small.set('b', entry('b'))
    // a is used, so b is the oldest when c arrives
    expect(small.get('a')?.text).toBe('a')
    small.set('c', entry('c'))
    expect([small.get('a')?.text, small.get('b'), small.get('c')?.text]).toEqual(['a', null, 'c'])
    // one copy bigger than the whole cache is not kept at all
    small.set('huge', { ...entry('huge'), bytes: 101 })
    expect(small.get('huge')).toBeNull()
    expect(small.size).toBe(2)
  })
})
