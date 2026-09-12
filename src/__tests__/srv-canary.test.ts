import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_KINDS } from '../../shared/kinds.mjs'
import { ALERT_GAP_MS, ago, canaryAlert, canarySentence, nextCanaryRecord, runSyncCanary } from '../../netlify/functions/lib/canary.mjs'
import type { CanaryRecord, CanaryResult } from '../../netlify/functions/lib/canary.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import digestFunction from '../../netlify/functions/digest.mjs'

// In September production rejected every write for days and nothing said so.
// The canary is the thing that says so: once an hour, one rolled-back test row
// of every kind through sync_posts (the database half is db-smoke step 15).

const passed: CanaryResult = { ok: true, checked: 14, failures: [], error: null }
const refused: CanaryResult = { ok: false, checked: 14, failures: [{ kind: 'habit', reason: 'rejected' }, { kind: 'routine', reason: 'rejected' }], error: null }
const at = (iso: string) => new Date(iso)

describe('runSyncCanary', () => {
  it('asks for every kind and passes the answer through', async () => {
    const calls: { path: string; body: unknown }[] = []
    const rest = async (path: string, init?: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init?.body)) })
      return { ok: false, checked: 14, failures: [{ kind: 'habit', reason: 'rejected' }] }
    }
    expect(await runSyncCanary(rest)).toEqual({ ok: false, checked: 14, failures: [{ kind: 'habit', reason: 'rejected' }], error: null })
    expect(calls).toEqual([{ path: 'rpc/sync_canary', body: { kinds: [...SYNC_KINDS] } }])
  })

  it('never throws: a check that cannot run says why', async () => {
    const rest = async () => {
      throw new Error('rpc/sync_canary: 404')
    }
    expect(await runSyncCanary(rest)).toEqual({ ok: false, checked: 0, failures: [], error: 'rpc/sync_canary: 404' })
  })
})

describe('nextCanaryRecord: what is kept, and when the owner is told', () => {
  it('records a pass with nothing failing and nothing to say', () => {
    const { record, alert } = nextCanaryRecord(null, passed, at('2026-09-12T10:00:00Z'))
    expect(record).toEqual({ ...passed, at: '2026-09-12T10:00:00.000Z', failingSince: null, alertedAt: null })
    expect(alert).toBe(false)
  })

  it('alerts on the first refusal, then stays quiet for twelve hours, then says it again', () => {
    const first = nextCanaryRecord(null, refused, at('2026-09-12T10:00:00Z'))
    expect(first.alert).toBe(true)
    const told = { ...first.record, alertedAt: first.record.at }

    const hourLater = nextCanaryRecord(told, refused, at('2026-09-12T11:00:00Z'))
    expect(hourLater.alert).toBe(false)
    expect(hourLater.record.failingSince).toBe('2026-09-12T10:00:00.000Z')
    expect(hourLater.record.alertedAt).toBe('2026-09-12T10:00:00.000Z')

    const justUnder = nextCanaryRecord(told, refused, new Date(Date.parse('2026-09-12T10:00:00Z') + ALERT_GAP_MS - 1))
    expect(justUnder.alert).toBe(false)
    expect(nextCanaryRecord(told, refused, new Date(Date.parse('2026-09-12T10:00:00Z') + ALERT_GAP_MS)).alert).toBe(true)
  })

  it('keeps asking to alert while no message has gone out', () => {
    const first = nextCanaryRecord(null, refused, at('2026-09-12T10:00:00Z'))
    expect(nextCanaryRecord(first.record, refused, at('2026-09-12T11:00:00Z')).alert).toBe(true)
  })

  it('clears "first seen" once it passes again', () => {
    const failing = nextCanaryRecord(null, refused, at('2026-09-12T10:00:00Z')).record
    expect(nextCanaryRecord(failing, passed, at('2026-09-12T11:00:00Z')).record.failingSince).toBeNull()
  })

  it('never alerts about a check that could not run — Admin shows that', () => {
    const { record, alert } = nextCanaryRecord(null, { ok: false, checked: 0, failures: [], error: 'rpc/sync_canary: 404' }, at('2026-09-12T10:00:00Z'))
    expect(alert).toBe(false)
    expect(record.failingSince).toBe('2026-09-12T10:00:00.000Z')
  })
})

describe('the words', () => {
  const now = at('2026-09-12T10:05:00Z')
  const record = (r: CanaryResult, iso = '2026-09-12T10:00:00Z', since: string | null = null): CanaryRecord => ({ ...r, at: at(iso).toISOString(), failingSince: since, alertedAt: null })

  it('says plainly that every kind went through', () => {
    expect(canarySentence(record(passed), now)).toBe('The server accepted a test write for all 14 kinds, 5 minutes ago.')
  })

  it('names the kinds it refused, and since when', () => {
    expect(canarySentence(record(refused, '2026-09-12T10:00:00Z', '2026-09-11T08:00:00.000Z'), now)).toBe(
      'The server refused a test write for habit (rejected) and routine (rejected), 5 minutes ago. First seen 26 hours ago.',
    )
  })

  it('says when it could not look at all, and when it has never looked', () => {
    expect(canarySentence(record({ ok: false, checked: 0, failures: [], error: 'rpc/sync_canary: 404' }, '2026-09-12T10:04:30Z'), now)).toBe(
      'The sync check could not run just now: rpc/sync_canary: 404.',
    )
    expect(canarySentence(null, now)).toBe('No sync check has run yet. The hourly digest runs one, or press Check now.')
  })

  it('counts time the way a person reads it', () => {
    expect([30_000, 60_000, 59 * 60_000, 3_600_000, 47 * 3_600_000, 49 * 3_600_000].map(ago)).toEqual([
      'just now',
      '1 minute ago',
      '59 minutes ago',
      '1 hour ago',
      '47 hours ago',
      '2 days ago',
    ])
  })

  it('tells the owner what it means for their edits', () => {
    const msg = canaryAlert(record(refused))
    expect(msg.title).toBe('Drafter: the server is refusing writes')
    expect(msg.body).toBe('The server refused a test write for habit and routine. New edits of those kinds are not reaching the server — details in Admin → Data.')
    expect(msg.text.split('\n').slice(-2)).toEqual(['- habit: rejected', '- routine: rejected'])
  })
})

describe('the hourly digest runs the canary once a run and tells the owner at most every 12 hours', () => {
  const SUPABASE = 'https://db.example.test'
  const REST = `${SUPABASE}/rest/v1/`
  const OWNER = '00000000-0000-0000-0000-00000000000a'
  const PEER = '00000000-0000-0000-0000-00000000000b'
  const runDigest = digestFunction as () => Promise<Response>

  let stored: CanaryRecord | null
  let answer: unknown
  let canaryCalls: { kinds: string[] }[]
  let emails: { to: string; subject: string; text: string }[]
  let settings: Record<string, unknown>[]

  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', SUPABASE)
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
    vi.stubEnv('RESEND_API_KEY', 'resend-key')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stored = null
    canaryCalls = []
    emails = []
    // digest_hour 24 never comes round, so nothing but the canary can send
    settings = [OWNER, PEER].map(user_id => ({ user_id, digest_email: true, push_subscriptions: [], digest_hour: 24, timezone: 'UTC' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === 'https://api.resend.com/emails') {
          emails.push(JSON.parse(String(init?.body)))
          return Response.json({ id: 'email-1' })
        }
        if (url === `${SUPABASE}/auth/v1/admin/users/${OWNER}`) return Response.json({ id: OWNER, email: 'owner@example.test' })
        if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
        const path = url.slice(REST.length)
        if (path === 'user_settings?select=*') return Response.json(settings)
        if (path === 'rpc/owner_user_id') return Response.json(OWNER)
        if (path === 'rpc/sync_canary') {
          canaryCalls.push(JSON.parse(String(init?.body)))
          return answer instanceof Response ? answer : Response.json(answer)
        }
        if (path.startsWith('app_config?key=eq.sync_canary')) return Response.json(stored ? [{ value: JSON.stringify(stored) }] : [])
        if (path === 'app_config?on_conflict=key' && method === 'POST') {
          stored = JSON.parse(JSON.parse(String(init?.body)).value)
          return new Response(null, { status: 201 })
        }
        if (path === 'posts?select=data,user_id&deleted=is.false') return Response.json([])
        if (path === 'household_members?select=household_id,user_id') return Response.json([])
        if (path.startsWith('posts?deleted=eq.true') && method === 'DELETE') return new Response(null, { status: 204 })
        throw new Error(`unexpected ${method} ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const runAt = async (iso: string) => {
    vi.setSystemTime(new Date(iso))
    return (await runDigest()).text()
  }

  it('checks every kind once per run, however many people are subscribed, and keeps the answer', async () => {
    answer = { ok: true, checked: 14, failures: [] }
    expect(await runAt('2026-09-12T10:00:00Z')).toBe('sent 0; sync check ok')
    expect(canaryCalls).toEqual([{ kinds: [...SYNC_KINDS] }])
    expect(stored).toEqual({ ok: true, checked: 14, failures: [], error: null, at: '2026-09-12T10:00:00.000Z', failingSince: null, alertedAt: null })
    expect(emails).toEqual([])
  })

  it('emails the owner, not everyone, on the first refusal — then not again for 12 hours', async () => {
    answer = { ok: false, checked: 14, failures: [{ kind: 'habit', reason: 'rejected' }] }
    expect(await runAt('2026-09-12T10:00:00Z')).toBe('sent 0; sync check failed: habit rejected')
    expect(emails.map(e => [e.to, e.subject])).toEqual([['owner@example.test', 'Drafter: the server is refusing writes']])
    expect(emails[0].text).toContain('- habit: rejected')
    expect(stored?.alertedAt).toBe('2026-09-12T10:00:00.000Z')

    await runAt('2026-09-12T11:00:00Z')
    await runAt('2026-09-12T21:59:00Z')
    expect(emails).toHaveLength(1)
    expect(stored?.failingSince).toBe('2026-09-12T10:00:00.000Z')

    await runAt('2026-09-12T22:00:00Z')
    expect(emails).toHaveLength(2)
    expect(stored?.alertedAt).toBe('2026-09-12T22:00:00.000Z')
  })

  it('still checks when nobody is subscribed, and with no way to reach the owner tries again next run', async () => {
    settings = []
    answer = { ok: false, checked: 14, failures: [{ kind: 'event', reason: 'rejected' }] }
    expect(await runAt('2026-09-12T10:00:00Z')).toBe('no subscribers; sync check failed: event rejected')
    expect(canaryCalls).toHaveLength(1)
    expect(emails).toEqual([])
    expect(stored?.alertedAt).toBeNull()
  })

  it('records a check that could not run without alerting anyone', async () => {
    answer = new Response('{"message":"Could not find the function public.sync_canary"}', { status: 404 })
    expect(await runAt('2026-09-12T10:00:00Z')).toBe('sent 0; sync check failed: rpc/sync_canary: 404')
    expect(stored?.error).toBe('rpc/sync_canary: 404')
    expect(emails).toEqual([])
  })
})
