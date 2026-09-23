import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The hourly digest, account by account: what it sends and in what order.
//
// - The watermarks go in first. A run that stalled on a send and was killed
//   after sending, before writing them, sent the same digest and nudges again
//   an hour later. Written first, a run that dies loses what it had not sent.
// - The morning digest lists the reader's own work (isMineTask), not the
//   household's: both phones listed and badged the other member's chores.
// - Email goes only where the site can send it, and a send that fails is on
//   the run's record rather than nowhere.
//
// Push is stubbed at its module and logs into the same list as the database
// writes, so the order is visible.

const { log, push } = vi.hoisted(() => ({ log: [] as { what: string; title?: string; body?: string; badge?: number; to?: string[] }[], push: { fails: false } }))
vi.mock('../../netlify/functions/push.mjs', () => ({
  pushConfigured: () => true,
  sendToAll: async (subs: { endpoint: string }[], payload: { title: string; body?: string; badge?: number }) => {
    log.push({ what: 'push', title: payload.title, body: payload.body, badge: payload.badge, to: subs.map(s => s.endpoint) })
    return { gone: [], failed: push.fails ? subs.map(s => ({ endpoint: s.endpoint, statusCode: 500 })) : [], updated: [] }
  },
}))
vi.mock('../../netlify/functions/lib/ai.mjs', () => ({ resolveProvider: () => null, complete: async () => ({ error: 'no model here' }) }))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import digestFunction from '../../netlify/functions/digest.mjs'

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const ME = 'a1b2c3d4-0000-4000-8000-0000000000aa'
const PARTNER = 'e5f6a7b8-0000-4000-8000-0000000000bb'
const STAMP = '2026-09-01T00:00:00.000Z'
const runDigest = digestFunction as () => Promise<Response>

type Row = { user_id: string | null; data: Record<string, unknown> }
let settings: Record<string, any>[]
let rows: Row[]
let jobRecord: Record<string, any> | null
let failWatermark: boolean
let resendOk: boolean
let emails: { to: string; subject: string }[]
/** Notices the run kept in the hub, as inserted into posts. */
let kept: { id: string; user_id: string; data: Record<string, any> }[]

const browser = (who: string) => ({ endpoint: `https://push.example.test/${who}`, keys: { p256dh: 'p', auth: 'a' } })
/** An account in UTC whose digest hour is midnight, so a run on any hour of a new day sends it. */
const account = (user_id: string, over: Record<string, unknown> = {}) => ({
  user_id,
  push_subscriptions: [browser(user_id.slice(0, 4))],
  digest_email: false,
  digest_hour: 0,
  timezone: 'UTC',
  nudged: {},
  ...over,
})
const task = (user_id: string, id: string, over: Record<string, unknown> = {}): Row => ({
  user_id,
  data: { kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: STAMP, updatedAt: STAMP, ...over },
})

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('URL', 'https://site.test')
  vi.stubEnv('RESEND_API_KEY', '')
  vi.useFakeTimers({ toFake: ['Date'] })
  log.length = 0
  settings = []
  rows = []
  jobRecord = null
  failWatermark = false
  resendOk = true
  emails = []
  kept = []
  push.fails = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (url === 'https://api.resend.com/emails') {
        emails.push({ to: body.to, subject: body.subject })
        return resendOk ? Response.json({ id: 'e1' }) : Response.json({ message: 'refused' }, { status: 422 })
      }
      if (url.startsWith(`${SUPABASE}/auth/v1/admin/users/`)) return Response.json({ email: `${url.slice(-4)}@example.test` })
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = url.slice(REST.length)
      if (path === 'user_settings?select=*') return Response.json(settings)
      if (path === 'rpc/owner_user_id') return Response.json(ME)
      if (path === 'rpc/sync_canary') return Response.json({ ok: true, checked: 15, failures: [] })
      if (path.startsWith('app_config?key=eq.sync_canary')) return Response.json([])
      if (path === 'app_config?on_conflict=key' && method === 'POST') return new Response(null, { status: 201 })
      if (path.startsWith('job_runs?job=eq.')) return Response.json([])
      if (path === 'job_runs?on_conflict=job' && method === 'POST') {
        jobRecord = body
        return new Response(null, { status: 201 })
      }
      if (path.startsWith('posts?select=id,data,user_id&deleted=is.false&')) {
        const page = rows.map(r => ({ id: r.data.id, ...structuredClone(r) }))
        return new Response(JSON.stringify(page), { headers: { 'content-range': page.length ? `0-${page.length - 1}/${page.length}` : '*/0' } })
      }
      if (path === 'household_members?select=household_id,user_id') {
        return Response.json([
          { household_id: 'h1', user_id: ME },
          { household_id: 'h1', user_id: PARTNER },
        ])
      }
      if (path.startsWith('user_settings?user_id=eq.') && method === 'PATCH') {
        const id = decodeURIComponent(path.slice('user_settings?user_id=eq.'.length))
        log.push({ what: `settings ${Object.keys(body).sort().join(',')}` })
        if (failWatermark) return new Response('down', { status: 503 })
        Object.assign(settings.find(s => s.user_id === id) ?? {}, body)
        return new Response(null, { status: 204 })
      }
      // the digest's own notice for the hub, when it writes one
      if (path.startsWith('rpc/record_kind_allowed')) return Response.json(true)
      if (path.startsWith('posts?id=eq.') && method === 'GET') return Response.json([])
      if (path === 'posts' && method === 'POST') {
        kept.push(body)
        return new Response(null, { status: 201 })
      }
      if (path.startsWith('posts?deleted=eq.true') && method === 'DELETE') return new Response(null, { status: 204 })
      throw new Error(`unexpected ${method} ${path}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const runAt = async (iso: string) => {
  vi.setSystemTime(new Date(iso))
  return (await runDigest()).text()
}
const morning = () => log.filter(e => e.what === 'push' && e.title === 'Good morning — today in Drafter')

describe('the watermarks are written before anything is sent', () => {
  it('claims the day, and the due check, ahead of the digest and the nudges', async () => {
    settings = [account(ME, { last_due_check: '2026-09-23T09:00:00.000Z' })]
    rows = [task(ME, 'Pay the plumber', { dueAt: '2026-09-22T10:00:00.000Z' }), task(ME, 'Call the vet', { dueAt: '2026-09-23T09:30:00.000Z' })]
    await runAt('2026-09-23T10:00:00.000Z')
    const order = log.map(e => (e.what === 'push' ? `push ${e.title}` : e.what))
    expect(order).toEqual(['settings last_digest_day,last_due_check,nudged', 'push Good morning — today in Drafter', 'push Due now: Call the vet'])
    expect(settings[0].last_digest_day).toBe('2026-09-23')
    expect(settings[0].last_due_check).toBe('2026-09-23T10:00:00.000Z')
  })

  it('sends nothing when the claim cannot be written, and says so on the run’s record', async () => {
    failWatermark = true
    settings = [account(ME, { last_due_check: '2026-09-23T09:00:00.000Z' })]
    rows = [task(ME, 'Pay the plumber', { dueAt: '2026-09-22T10:00:00.000Z' }), task(ME, 'Call the vet', { dueAt: '2026-09-23T09:30:00.000Z' })]
    const report = await runAt('2026-09-23T10:00:00.000Z')
    expect(log.filter(e => e.what === 'push')).toEqual([])
    expect(report).toContain('1 failure(s): watermark')
    expect(jobRecord?.ok).toBe(false)
    expect(jobRecord?.failures[0]).toMatch(new RegExp(`^watermark ${ME}: `))
  })

  it('the next run, with the claim in place, does not send the same again', async () => {
    settings = [account(ME, { last_due_check: '2026-09-23T09:00:00.000Z' })]
    rows = [task(ME, 'Pay the plumber', { dueAt: '2026-09-22T10:00:00.000Z' }), task(ME, 'Call the vet', { dueAt: '2026-09-23T09:30:00.000Z' })]
    await runAt('2026-09-23T10:00:00.000Z')
    log.length = 0
    await runAt('2026-09-23T11:00:00.000Z')
    expect(log.filter(e => e.what === 'push')).toEqual([])
  })
})

describe('the morning digest is the reader’s own work', () => {
  it('lists and badges what is theirs to do — not the chores handed to the other member', async () => {
    settings = [account(ME), account(PARTNER)]
    rows = [
      // mine: filed by me with nobody on it, and one handed to me by my partner
      task(ME, 'Renew the insurance', { dueAt: '2026-09-22T10:00:00.000Z' }),
      task(PARTNER, 'Book the dentist', { dueAt: '2026-09-23T00:00:00.000Z', assigneeId: ME }),
      // theirs: handed to my partner, and filed by them with nobody on it
      task(ME, 'Take the bins out', { dueAt: '2026-09-23T00:00:00.000Z', assigneeId: PARTNER }),
      task(PARTNER, 'Water the plants', { dueAt: '2026-09-22T10:00:00.000Z' }),
    ]
    await runAt('2026-09-23T15:00:00.000Z')
    const [mine, theirs] = [morning().find(p => p.to?.[0].includes('a1b2')), morning().find(p => p.to?.[0].includes('e5f6'))]
    expect(mine?.body?.split('\n')).toEqual(['1 overdue: Renew the insurance', '1 due today: Book the dentist'])
    expect(mine?.badge).toBe(2)
    expect(theirs?.body?.split('\n')).toEqual(['1 overdue: Water the plants', '1 due today: Take the bins out'])
    expect(theirs?.badge).toBe(2)
  })
})

describe('the digest by email', () => {
  it('is not attempted, and nothing is recorded, on a site that cannot send email', async () => {
    settings = [account(ME, { digest_email: true })]
    rows = [task(ME, 'Renew the insurance', { dueAt: '2026-09-22T10:00:00.000Z' })]
    await runAt('2026-09-23T15:00:00.000Z')
    expect(emails).toEqual([])
    expect(jobRecord?.ok).toBe(true)
  })

  it('goes where the site can send it', async () => {
    vi.stubEnv('RESEND_API_KEY', 'resend-key')
    settings = [account(ME, { digest_email: true })]
    rows = [task(ME, 'Renew the insurance', { dueAt: '2026-09-22T10:00:00.000Z' })]
    await runAt('2026-09-23T15:00:00.000Z')
    expect(emails).toEqual([{ to: '00aa@example.test', subject: 'Today in Drafter: 0 due, 1 overdue' }])
    expect(jobRecord?.ok).toBe(true)
  })

  it('and when the email service refuses it, the run’s record says so', async () => {
    vi.stubEnv('RESEND_API_KEY', 'resend-key')
    resendOk = false
    settings = [account(ME, { digest_email: true })]
    rows = [task(ME, 'Renew the insurance', { dueAt: '2026-09-22T10:00:00.000Z' })]
    const report = await runAt('2026-09-23T15:00:00.000Z')
    expect(emails).toHaveLength(1)
    expect(report).toContain(`digest email ${ME}: the email service refused it`)
    expect(jobRecord?.ok).toBe(false)
    expect(jobRecord?.failures).toEqual([`digest email ${ME}: the email service refused it`])
  })
})

describe('the digest that went out is kept in the hub', () => {
  it('under its reader, a notice a day, as the lock screen said it', async () => {
    settings = [account(ME)]
    rows = [task(ME, 'Renew the insurance', { dueAt: '2026-09-22T10:00:00.000Z' })]
    await runAt('2026-09-23T15:00:00.000Z')
    expect(kept).toEqual([
      {
        id: `notice~${ME}~digest~2026-09-23`,
        user_id: ME,
        updated_at: '2026-09-23T15:00:00.000Z',
        data: {
          kind: 'notice',
          id: `notice~${ME}~digest~2026-09-23`,
          at: '2026-09-23T15:00:00.000Z',
          type: 'digest',
          title: 'Good morning — today in Drafter',
          lines: ['1 overdue: Renew the insurance'],
          createdAt: '2026-09-23T15:00:00.000Z',
          updatedAt: '2026-09-23T15:00:00.000Z',
        },
      },
    ])
  })

  it('on a Sunday it opens the review, as the push does', async () => {
    settings = [account(ME)]
    await runAt('2026-09-27T15:00:00.000Z')
    expect(kept[0].data).toMatchObject({ type: 'digest', target: { kind: 'review', id: '2026-09-27' }, lines: ['Sunday: your weekly review is ready.'] })
  })

  it('only when it reached them: a digest every device refused is not kept', async () => {
    push.fails = true
    settings = [account(ME)]
    rows = [task(ME, 'Renew the insurance', { dueAt: '2026-09-22T10:00:00.000Z' })]
    await runAt('2026-09-23T15:00:00.000Z')
    expect(kept).toEqual([])
  })
})
