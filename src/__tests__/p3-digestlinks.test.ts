import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The morning digest's links open a planning sheet: Plan my day on a weekday,
// the week plan over the review on a Sunday with something to plan. Opening a
// sheet writes nothing, so a link is safe to follow from any inbox. Push is
// stubbed at its module; the email goes through a stubbed Resend.

const { pushes } = vi.hoisted(() => ({ pushes: [] as { title: string; body: string; url: string }[] }))
vi.mock('../../netlify/functions/push.mjs', () => ({
  pushConfigured: () => true,
  sendToAll: async (_subs: unknown[], payload: { title: string; body: string; url: string }) => {
    pushes.push(payload)
    return { gone: [], failed: [], updated: [] }
  },
}))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import digestFunction from '../../netlify/functions/digest.mjs'

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const USER = '00000000-0000-0000-0000-0000000000aa'
const STAMP = '2026-01-01T00:00:00.000Z'
const runDigest = digestFunction as () => Promise<Response>

let rows: { user_id: string | null; data: Record<string, unknown> }[]
let emails: { subject: string; text: string }[]

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('RESEND_API_KEY', 'resend-key')
  vi.stubEnv('URL', 'https://site.test')
  // no AI provider, so Sunday's automatic review draft never leaves the test
  vi.stubEnv('NVIDIA_API_KEY', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.useFakeTimers({ toFake: ['Date'] })
  pushes.length = 0
  emails = []
  rows = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === 'https://api.resend.com/emails') {
        emails.push(JSON.parse(String(init?.body)))
        return Response.json({ id: 'email-1' })
      }
      if (url === `${SUPABASE}/auth/v1/admin/users/${USER}`) return Response.json({ id: USER, email: 'me@example.test' })
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = url.slice(REST.length)
      if (path === 'user_settings?select=*') {
        return Response.json([{ user_id: USER, digest_email: true, push_subscriptions: [{ endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } }], digest_hour: 0, timezone: 'UTC', nudged: {} }])
      }
      if (path === 'rpc/owner_user_id') return Response.json(USER)
      if (path === 'rpc/sync_canary') return Response.json({ ok: true, checked: 14, failures: [] })
      if (path.startsWith('app_config?key=eq.sync_canary')) return Response.json([])
      if (path === 'app_config?on_conflict=key' && method === 'POST') return new Response(null, { status: 201 })
      if (path === 'posts?select=data,user_id&deleted=is.false') return Response.json(rows)
      if (path === 'household_members?select=household_id,user_id') return Response.json([])
      if (path.startsWith('user_settings?user_id=eq.') && method === 'PATCH') return new Response(null, { status: 204 })
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
const mine = (data: Record<string, unknown>) => ({ user_id: USER, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
const task = (id: string, title: string, over: Record<string, unknown> = {}) => mine({ kind: 'task', id, title, description: '', status: 'todo', priority: 'normal', tags: [], ...over })

describe('the digest opens a planning sheet', () => {
  it('on a Sunday with something to plan: the plan line, and a link to the week plan over the review', async () => {
    rows = [
      mine({ kind: 'recipe', id: 'r1', name: 'Pasta bake', ingredients: [], tags: [] }),
      mine({ kind: 'meal', id: 'meal~2026-08-01~dinner', date: '2026-08-01', slot: 'dinner', recipeId: 'r1', title: 'Pasta bake' }),
    ]
    expect(await runAt('2026-09-13T09:00:00Z')).toMatch(/^sent 1;/)
    expect(pushes).toHaveLength(1)
    expect(pushes[0].url).toBe('https://site.test/?view=review&plan=week')
    expect(pushes[0].body.split('\n')).toEqual(['Plan next week: 1 dinner to fill', 'Sunday: your weekly review is ready.'])
    expect(emails[0].text.split('\n').slice(-2)).toEqual(['Plan the week: https://site.test/?view=review&plan=week', 'Open Drafter: https://site.test/'])
  })

  it('on a Sunday with nothing to plan: the review on its own', async () => {
    await runAt('2026-09-13T09:00:00Z')
    expect(pushes[0].url).toBe('https://site.test/?view=review')
    expect(pushes[0].body).toBe('Sunday: your weekly review is ready.')
    expect(emails[0].text).not.toContain('plan=')
  })

  it('on a weekday: your focus first, and a link to Plan my day', async () => {
    rows = [
      task('t1', 'Call the bank', { focusOn: '2026-09-14', focusBy: USER }),
      task('t2', 'Someone else’s pick', { focusOn: '2026-09-14', focusBy: 'someone-else' }),
      task('t3', 'Fix the fence', { dueAt: '2026-09-10T09:00:00.000Z' }),
    ]
    await runAt('2026-09-14T09:00:00Z')
    expect(pushes).toHaveLength(1)
    expect(pushes[0].url).toBe('https://site.test/?plan=day')
    expect(pushes[0].body.split('\n')).toEqual(['Focus: Call the bank', '1 overdue: Fix the fence'])
    expect(emails[0].text).toContain('Plan your day: https://site.test/?plan=day')
    expect(emails[0].text).not.toContain('Plan next week')
  })
})
