import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_ERRORS_TTL_MS, runBackup } from '../../netlify/functions/lib/backup.mjs'
import { FAILURES_KEPT, nextJobRecord, recordJobRun } from '../../netlify/functions/lib/jobhealth.mjs'
import type { JobRecord } from '../../netlify/functions/lib/jobhealth.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import backupFunction from '../../netlify/functions/backup.mjs'
// @ts-expect-error — as above
import digestFunction from '../../netlify/functions/digest.mjs'
// @ts-expect-error — as above
import adminFunction from '../../netlify/functions/admin.mjs'

// backup.mjs and digest.mjs used to log a failure where nobody looks and
// answer 200 either way, so a job that failed every night — or stopped being
// run — looked like one that worked. Each run now leaves a record in
// public.job_runs that only the service key reads; Admin → Data and the
// owner's Today read it through /api/admin. The jobs' answers are unchanged.

const SUPABASE = 'https://db.example.test'
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const at = (iso: string) => new Date(iso)

describe('nextJobRecord: what a run leaves', () => {
  it('a run that worked', () => {
    expect(nextJobRecord(null, { counts: { sent: 2 } }, at('2026-09-22T10:00:00Z'))).toEqual({
      at: '2026-09-22T10:00:00.000Z',
      ok: true,
      counts: { sent: 2 },
      failures: [],
      failureCount: 0,
      failingSince: null,
      lastOkAt: '2026-09-22T10:00:00.000Z',
      lastGoodAt: '2026-09-22T10:00:00.000Z',
    })
  })

  it('a failure keeps when it last worked, and a streak keeps when it began, until it works again', () => {
    const good = nextJobRecord(null, {}, at('2026-09-21T00:00:00Z'))
    const failed = nextJobRecord(good, { failures: ['storage 503'] }, at('2026-09-22T00:00:00Z'))
    expect(failed).toMatchObject({ ok: false, failures: ['storage 503'], failureCount: 1, failingSince: '2026-09-22T00:00:00.000Z', lastOkAt: good.at, lastGoodAt: good.at })
    const still = nextJobRecord(failed, { failures: ['storage 503'] }, at('2026-09-23T00:00:00Z'))
    expect(still.failingSince).toBe('2026-09-22T00:00:00.000Z')
    expect(nextJobRecord(still, {}, at('2026-09-24T00:00:00Z'))).toMatchObject({ ok: true, failingSince: null, lastOkAt: '2026-09-24T00:00:00.000Z' })
  })

  it('keeps the first few failures and how many there were; a backup that wrote every snapshot is good even when housekeeping failed', () => {
    const r = nextJobRecord(null, { good: true, failures: Array.from({ length: 9 }, (_, i) => `photos of u${i}: 503`) }, at('2026-09-22T00:00:00Z'))
    expect(r.failures).toHaveLength(FAILURES_KEPT)
    expect(r.failureCount).toBe(9)
    expect(r).toMatchObject({ ok: false, lastOkAt: null, lastGoodAt: '2026-09-22T00:00:00.000Z' })
  })

  it('never fails the job for want of its own record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rest = async () => {
      throw new Error('job_runs: 404')
    }
    await expect(recordJobRun(rest, 'digest', {})).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/digest: could not record this run: job_runs: 404/))
    warn.mockRestore()
  })
})

// ---------------------------------------------------------------- a fake host

type Row = { id: string; user_id: string; data: Record<string, unknown> }
let posts: Row[]
let uploads: Map<string, unknown>
let uploadFails: boolean
let postsUnreadable: boolean
let jobRuns: Map<string, Record<string, unknown>>
let deletes: string[]
let snapshotsListed: { name: string; id: string | null; updated_at?: string }[]
let clientErrors: Record<string, unknown>[]
let errorsMissing: boolean
let canary: unknown
let settings: Record<string, unknown>[]
let settingsDown: boolean
let signedIn: string

/** PostgREST answering restAll: the page after the id it carried on from, and how many were left. */
function page(url: string, rows: Row[]) {
  const q = new URL(`https://x/${url}`).searchParams
  const after = q.get('id')?.replace(/^gt\./, '') ?? null
  const left = rows.filter(r => after === null || r.id > after).sort((x, y) => (x.id < y.id ? -1 : 1))
  const out = left.slice(0, Number(q.get('limit') ?? 1000))
  if (postsUnreadable) return new Response(JSON.stringify(out))
  return new Response(JSON.stringify(out), { headers: { 'content-range': out.length ? `0-${out.length - 1}/${left.length}` : `*/${left.length}` } })
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-22T00:00:00.000Z') })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  posts = [
    { id: 't1', user_id: A, data: { kind: 'task', id: 't1', title: 'Bins', status: 'todo', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' } },
    { id: 't2', user_id: B, data: { kind: 'task', id: 't2', title: 'Fence', status: 'todo', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' } },
  ]
  uploads = new Map()
  uploadFails = false
  postsUnreadable = false
  jobRuns = new Map()
  deletes = []
  snapshotsListed = []
  clientErrors = []
  errorsMissing = false
  canary = null
  settings = []
  settingsDown = false
  signedIn = 'owner@example.test'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(SUPABASE, '')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const rest = url.startsWith('/rest/v1/') ? decodeURIComponent(url.slice('/rest/v1/'.length)) : null
      if (url === '/auth/v1/user') return Response.json({ id: A, email: signedIn })
      if (url.startsWith('/auth/v1/admin/users')) return Response.json({ users: [] })
      if (rest?.startsWith('posts?select=id,data,user_id&deleted=is.false')) return page(rest, posts)
      if (rest?.startsWith('posts?select=id,user_id,data&kind=eq.garment')) return page(rest, [])
      if (url === '/storage/v1/object/list/media' && method === 'POST') return Response.json(body.prefix === 'backups/' ? snapshotsListed.filter(s => s.id === null) : [])
      if (url.startsWith('/storage/v1/object/media/backups/') && method === 'POST') {
        if (uploadFails) return new Response('{"message":"storage is down"}', { status: 503 })
        uploads.set(url.slice('/storage/v1/object/media/'.length), body)
        return Response.json({ Key: url })
      }
      if (url === '/storage/v1/object/media' && method === 'DELETE') return Response.json([])
      if (method === 'DELETE' && rest && /^(posts_history|posts\?deleted=eq\.true)/.test(rest)) return new Response(null, { status: 204, headers: { 'content-range': '*/0' } })
      if (rest?.startsWith('client_errors')) {
        if (errorsMissing) return new Response('{"message":"relation does not exist"}', { status: 404 })
        if (method === 'DELETE') {
          deletes.push(rest)
          return rest.includes('select=id') ? Response.json(clientErrors.map(e => ({ id: e.id }))) : new Response(null, { status: 204, headers: { 'content-range': '*/3' } })
        }
        return Response.json(clientErrors)
      }
      if (rest?.startsWith('job_runs?job=eq.')) {
        const job = rest.slice('job_runs?job=eq.'.length).split('&')[0]
        return Response.json(jobRuns.has(job) ? [jobRuns.get(job)] : [])
      }
      if (rest === 'job_runs?select=*') return Response.json([...jobRuns.values()])
      if (rest === 'job_runs?on_conflict=job' && method === 'POST') {
        jobRuns.set(body.job, body)
        return new Response(null, { status: 201 })
      }
      if (rest === 'user_settings?select=*') return settingsDown ? new Response('down', { status: 503 }) : Response.json(settings)
      if (rest === 'rpc/owner_user_id') return Response.json(A)
      if (rest === 'rpc/sync_canary') return Response.json({ ok: true, checked: body.kinds.length, failures: [] })
      if (rest?.startsWith('app_config?key=eq.owner_email')) return Response.json([{ value: 'owner@example.test' }])
      if (rest?.startsWith('app_config?key=eq.sync_canary')) return Response.json(canary ? [{ value: JSON.stringify(canary) }] : [])
      if (rest === 'app_config?on_conflict=key' && method === 'POST') {
        canary = JSON.parse(body.value)
        return new Response(null, { status: 201 })
      }
      if (rest === 'household_members?select=household_id,user_id') return Response.json([])
      // the nightly let-go of old notices (lib/notices.mjs): not stored here, so nothing to let go
      if (rest === 'rpc/record_kind_allowed' && method === 'POST') return Response.json(false)
      throw new Error(`unexpected ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The record a job left, as the app reads it back. */
const recordOf = (job: string) => jobRuns.get(job) as Record<string, unknown> | undefined

describe('the nightly backup records each run', () => {
  const runBackupJob = backupFunction as () => Promise<Response>

  it('a night that worked: counts, and the same answer as ever', async () => {
    const res = await runBackupJob()
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('backed up 2 user(s)')
    expect(recordOf('backup')).toMatchObject({
      job: 'backup',
      ran_at: '2026-09-22T00:00:00.000Z',
      ok: true,
      counts: { snapshots: 2, records: 2, encrypted: false },
      failures: [],
      failure_count: 0,
      failing_since: null,
      last_ok_at: '2026-09-22T00:00:00.000Z',
      last_good_at: '2026-09-22T00:00:00.000Z',
    })
  })

  it('a night whose snapshots could not be written: failed, and not a good backup — still answering 200', async () => {
    await runBackupJob()
    vi.setSystemTime(new Date('2026-09-23T00:00:00.000Z'))
    uploadFails = true
    const res = await runBackupJob()
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/^backed up 0 user\(s\); 2 failure\(s\): /)
    const r = recordOf('backup')!
    expect(r).toMatchObject({ ok: false, failure_count: 2, failing_since: '2026-09-23T00:00:00.000Z', last_good_at: '2026-09-22T00:00:00.000Z' })
    expect((r.failures as string[])[0]).toMatch(/storage \/object\/media\/backups\/.*: 503/)
  })

  it('a night that could not read the records at all: recorded as failed, and still thrown as before', async () => {
    postsUnreadable = true
    await expect(runBackupJob()).rejects.toThrow('the server did not say how many rows there are')
    expect(recordOf('backup')).toMatchObject({ ok: false, last_good_at: null, failures: ['the run stopped: posts: the server did not say how many rows there are'] })
  })

  it('drops client error reports nobody has hit for thirty days', async () => {
    const report = await runBackup(new Date('2026-09-22T00:00:00.000Z'))
    expect(report.errorsPurged).toBe(3)
    const cutoff = new Date(Date.parse('2026-09-22T00:00:00.000Z') - CLIENT_ERRORS_TTL_MS).toISOString()
    expect(deletes).toEqual([`client_errors?last_at=lt.${cutoff}`])
    expect(CLIENT_ERRORS_TTL_MS).toBe(30 * 86_400_000)
    // before the migration there is nothing to purge, and nothing fails for it
    errorsMissing = true
    const before = await runBackup(new Date('2026-09-22T00:00:00.000Z'))
    expect(before.errorsPurged).toBeNull()
    expect(before.failures).toEqual([])
  })
})

describe('the hourly digest records each run', () => {
  const runDigest = digestFunction as () => Promise<Response>

  it('a run with nobody subscribed is still a run that worked', async () => {
    expect(await (await runDigest()).text()).toBe('no subscribers; sync check ok')
    expect(recordOf('digest')).toMatchObject({ ok: true, counts: { subscribers: 0, sent: 0, draftsStarted: 0 }, ran_at: '2026-09-22T00:00:00.000Z' })
  })

  it('a run that throws is recorded as failed, and still throws', async () => {
    settingsDown = true
    await expect(runDigest()).rejects.toThrow('user_settings: 503')
    expect(recordOf('digest')).toMatchObject({ ok: false, failures: ['the run stopped: user_settings: 503'] })
  })
})

describe('/api/admin: the jobs and the error list, for the site owner', () => {
  const admin = adminFunction as (req: Request) => Promise<Response>
  const act = (action: string, payload: Record<string, unknown> = {}) =>
    admin(new Request('https://site.test/api/admin', { method: 'POST', headers: { authorization: 'Bearer s', 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }) }))

  it('opsHealth: the sync check and each job’s last run, as the records hold them', async () => {
    const backup: JobRecord = nextJobRecord(null, { counts: { snapshots: 2 } }, at('2026-09-22T00:00:00Z'))
    jobRuns.set('backup', { job: 'backup', ran_at: backup.at, ok: true, counts: backup.counts, failures: [], failure_count: 0, failing_since: null, last_ok_at: backup.at, last_good_at: backup.at })
    canary = { ok: true, checked: 22, failures: [], error: null, at: '2026-09-22T09:00:00.000Z', failingSince: null, alertedAt: null }
    const body = await (await act('opsHealth')).json()
    expect(body.jobs).toEqual({ backup: { ...backup }, digest: null })
    expect(body.syncCheck.record.at).toBe('2026-09-22T09:00:00.000Z')
    // a backup with a record of its own needs no look in the bucket
    expect(body.lastSnapshotAt).toBeNull()
  })

  it('opsHealth: before the backup has a record, the newest snapshot stands in; unreadable records are null, not an error', async () => {
    snapshotsListed = [{ name: A, id: null }]
    const inner = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input).replace(SUPABASE, '')
      if (url === '/rest/v1/job_runs?select=*') return new Response('{"message":"relation job_runs does not exist"}', { status: 404 })
      if (url === '/storage/v1/object/list/media' && JSON.parse(String(init?.body)).prefix === `backups/${A}/`) {
        return Response.json([{ name: '2026-09-21.json', id: 'o1', updated_at: '2026-09-21T00:00:04.000Z', metadata: { size: 10 } }])
      }
      return inner(input, init)
    })
    const res = await act('opsHealth')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.jobs).toBeNull()
    expect(body.lastSnapshotAt).toBe('2026-09-21T00:00:04.000Z')
  })

  it('listErrors and clearErrors: newest first, one or all, and a plain message before the migration', async () => {
    clientErrors = [{ id: '11111111-1111-4111-8111-111111111111', message: 'TypeError: x', stack: null, count: 3, first_at: 'f', last_at: 'l', build: 'b1', platform: 'ios', view: 'home', path: '/' }]
    expect((await (await act('listErrors')).json()).errors).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', message: 'TypeError: x', stack: null, count: 3, firstAt: 'f', lastAt: 'l', build: 'b1', platform: 'ios', view: 'home', path: '/' },
    ])
    expect(await (await act('clearErrors')).json()).toEqual({ cleared: 1 })
    expect(await (await act('clearErrors', { id: '11111111-1111-4111-8111-111111111111' })).json()).toEqual({ cleared: 1 })
    expect(deletes).toEqual(['client_errors?id=not.is.null&select=id', 'client_errors?id=eq.11111111-1111-4111-8111-111111111111&select=id'])
    expect((await act('clearErrors', { id: 'x); drop table' })).status).toBe(400)
    errorsMissing = true
    const missing = await (await act('listErrors')).json()
    expect(missing.errors).toEqual([])
    expect(missing.unavailable).toMatch(/v3\.29 migration/)
  })

  it('answers nobody but the site owner', async () => {
    signedIn = 'member@example.test'
    for (const action of ['opsHealth', 'listErrors', 'clearErrors']) expect((await act(action)).status).toBe(403)
    expect(deletes).toEqual([])
  })
})
