import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import feedFunction from '../../netlify/functions/feed.mjs'

// GET /api/feed.ics?token=… was broken in production from 10 September
// (d1775f5): the helpers it reads with, baseUrl and serviceHeaders, had moved
// into lib/feedrows.mjs and stayed private there, so every request threw — the
// household lookup quietly fell back to the reader alone and the rows loader
// answered 502. Nothing ran the handler itself; this does, against a stubbed
// Supabase.

const feed = feedFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const ME = '00000000-0000-0000-0000-00000000000a'
const PEER = '00000000-0000-0000-0000-00000000000b'
const TOKEN = 't'.repeat(32)
const at = '2026-09-01T00:00:00.000Z'

const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'task',
  id,
  title,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  dueAt: '2026-09-20T14:00:00.000Z',
  createdAt: at,
  updatedAt: at,
  ...extra,
})

const stored = [
  { user_id: ME, data: task('mine', 'Bins out') },
  { user_id: ME, data: { kind: 'event', id: 'myev', title: 'Dentist', start: '2026-09-21T10:00:00.000Z', end: '2026-09-21T11:00:00.000Z', allDay: false, createdAt: at, updatedAt: at } },
  { user_id: PEER, data: task('theirs', 'Peer chore') },
  { user_id: PEER, data: task('assigned', 'Pick up the kids', { assigneeId: ME }) },
  { user_id: PEER, data: { kind: 'journal', id: 'journal~2026-09-20~p1', date: '2026-09-20', body: 'Peer diary entry', createdAt: at, updatedAt: at } },
  { user_id: PEER, data: { kind: 'habit', id: 'peer-habit', name: 'Peer habit', days: [], done: [], createdAt: at, updatedAt: at } },
]

let requests: { url: string; headers: Headers }[]

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, headers: new Headers(init?.headers) })
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = decodeURIComponent(url.slice(REST.length))
      if (path.startsWith('user_settings?feed_token=eq.')) {
        return Response.json(path.startsWith(`user_settings?feed_token=eq.${TOKEN}&`) ? [{ user_id: ME, feed_token: TOKEN, timezone: 'Europe/London' }] : [])
      }
      if (path === `household_members?user_id=eq.${ME}&select=household_id`) return Response.json([{ household_id: 'home' }])
      if (path === 'household_members?household_id=eq.home&select=user_id') return Response.json([{ user_id: ME }, { user_id: PEER }])
      if (path.startsWith('posts?select=data,user_id&deleted=is.false&user_id=in.')) return Response.json(stored)
      throw new Error(`unexpected read ${path}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const fetchFeed = (token = TOKEN) => feed(new Request(`https://drafterz.example/api/feed.ics?token=${token}`))

describe('GET /api/feed.ics', () => {
  it('serves a valid token as a calendar of the reader’s own rows', async () => {
    const res = await fetchFeed()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    const ics = await res.text()
    const uids = [...ics.matchAll(/^UID:(.+)$/gm)].map(m => m[1].trim()).sort()
    expect(uids).toEqual(['event-myev@drafter', 'task-assigned@drafter', 'task-mine@drafter'])
    expect(ics).not.toMatch(/Peer chore|Peer diary entry|Peer habit/)
  })

  it('reads the household’s rows with the service key', async () => {
    await fetchFeed()
    const posts = requests.find(r => r.url.includes('/rest/v1/posts?'))
    expect(decodeURIComponent(posts!.url)).toContain(`user_id=in.("${ME}","${PEER}")`)
    expect(requests.every(r => r.headers.get('apikey') === 'service-key')).toBe(true)
  })

  it('answers 404 to a token nobody holds, without reading any rows', async () => {
    const res = await fetchFeed('x'.repeat(32))
    expect(res.status).toBe(404)
    expect(requests.some(r => r.url.includes('/rest/v1/posts?'))).toBe(false)
  })
})
