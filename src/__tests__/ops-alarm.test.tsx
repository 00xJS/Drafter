import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncCheck } from '../admin'
import { Admin } from '../components/Admin'
import { ErrorsCard, JobsCard, jobSummary } from '../components/AdminOps'
import { SyncAlarmBanner } from '../components/Today'
import type { ClientError, JobRecord, OpsHealth } from '../ops'
import {
  BACKUP_STALE_MS,
  DIGEST_STALE_MS,
  SYNC_ALARM_SNOOZE_MS,
  howLong,
  jobAlarms,
  opsAlarmOf,
  readJobAlarmDismissals,
  syncAlarmOf,
  writeJobAlarmDismissal,
} from '../syncalarm'

// The owner's Today banner used to speak for the sync check alone, and hid a
// check older than two days — so a digest that had stopped, or a backup that
// failed every night, said nothing anywhere but Admin. It now carries the
// scheduled jobs too (v3.29): the digest not run for three hours, no backup
// that worked for a day and a half, or a run that failed.

const HOUR = 3_600_000
const NOW = new Date('2026-09-22T15:00:00.000Z')
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString()

const run = (over: Partial<JobRecord> = {}): JobRecord => ({
  at: ago(1),
  ok: true,
  counts: {},
  failures: [],
  failureCount: 0,
  failingSince: null,
  lastOkAt: ago(1),
  lastGoodAt: ago(1),
  ...over,
})
const check = (record: Partial<NonNullable<SyncCheck['record']>> | null, sentence = 'The server accepted a test write for all 22 kinds, 1 hour ago.'): SyncCheck => ({
  sentence,
  record: record && { ok: true, checked: 22, failures: [], error: null, at: ago(1), failingSince: null, alertedAt: null, ...record },
})
const health = (over: Partial<OpsHealth> = {}): OpsHealth => ({ syncCheck: check({}), jobs: { backup: run({ at: ago(15), lastOkAt: ago(15), lastGoodAt: ago(15) }), digest: run() }, ...over })

describe('jobAlarms: when a scheduled job needs the owner', () => {
  it('says nothing while both jobs are working', () => {
    expect(jobAlarms(health(), NOW)).toEqual([])
  })

  it('a nightly backup that failed, in its own first words, with how many more and when', () => {
    const failed = run({ at: ago(15), ok: false, failures: ['a1b2: storage /object/media/backups/a1b2/2026-09-22.json: 503 down'], failureCount: 3, failingSince: ago(15), lastGoodAt: ago(39) })
    expect(jobAlarms(health({ jobs: { backup: failed, digest: run() } }), NOW)).toEqual([
      {
        job: 'backup',
        title: 'Nightly backup failed:',
        sentence: 'a1b2: storage /object/media/backups/a1b2/2026-09-22.json: 503 down (and 2 more), 15 hours ago.',
        since: `backup-failed:${ago(15)}`,
      },
    ])
    // snapshots written, housekeeping failed: a lesser thing, said as one
    const tidy = run({ at: ago(15), ok: false, failures: ['photos: 503'], failureCount: 1, failingSince: ago(15), lastGoodAt: ago(15) })
    expect(jobAlarms(health({ jobs: { backup: tidy, digest: run() } }), NOW)[0].title).toBe('The nightly backup had a problem:')
  })

  it('no backup that worked for a day and a half: the job has stopped', () => {
    const quiet = run({ at: ago(40), lastOkAt: ago(40), lastGoodAt: ago(40) })
    const [alarm] = jobAlarms(health({ jobs: { backup: quiet, digest: run() } }), NOW)
    expect(alarm).toEqual({ job: 'backup', title: 'No recent backup.', sentence: 'The last nightly backup that worked was 40 hours ago.', since: `backup-stale:${ago(40)}` })
    const edge = run({ at: new Date(NOW.getTime() - BACKUP_STALE_MS).toISOString(), lastGoodAt: new Date(NOW.getTime() - BACKUP_STALE_MS).toISOString() })
    expect(jobAlarms(health({ jobs: { backup: edge, digest: run() } }), NOW)).toEqual([])
  })

  it('before the backup has a record, the newest snapshot stands in, and with neither it says nothing', () => {
    expect(jobAlarms(health({ jobs: { backup: null, digest: run() }, lastSnapshotAt: ago(10) }), NOW)).toEqual([])
    expect(jobAlarms(health({ jobs: { backup: null, digest: run() }, lastSnapshotAt: ago(72) }), NOW)[0].sentence).toBe('The last nightly backup that worked was 3 days ago.')
    expect(jobAlarms(health({ jobs: null, lastSnapshotAt: null, syncCheck: check({ at: ago(1) }) }), NOW)).toEqual([])
  })

  it('an hourly digest not heard from for three hours has stopped — its sync check counts as hearing from it', () => {
    const stale = health({ jobs: { backup: run({ at: ago(15), lastGoodAt: ago(15) }), digest: run({ at: ago(5) }) }, syncCheck: check({ at: ago(5) }) })
    expect(jobAlarms(stale, NOW)).toEqual([
      {
        job: 'digest',
        title: 'The hourly digest has stopped.',
        sentence: 'It last ran 5 hours ago, so no digest, due-now nudge or sync check has gone out since.',
        since: `digest-stale:${ago(5)}`,
      },
    ])
    // records begin with this deploy: until then the sync check's time is the digest's
    expect(jobAlarms(health({ jobs: { backup: run(), digest: null }, syncCheck: check({ at: ago(1) }) }), NOW)).toEqual([])
    expect(jobAlarms(health({ jobs: { backup: run(), digest: null }, syncCheck: check({ at: ago(4) }) }), NOW)[0].title).toBe('The hourly digest has stopped.')
    const edge = new Date(NOW.getTime() - DIGEST_STALE_MS).toISOString()
    expect(jobAlarms(health({ jobs: { backup: run(), digest: run({ at: edge }) }, syncCheck: check({ at: edge }) }), NOW)).toEqual([])
  })

  it('once the digest has a record, a fresh sync check does not keep a stalled digest looking alive', () => {
    // the check is written as a run STARTS: a run that went on to hang until
    // Netlify stopped it refreshed the check every hour and never finished
    const hung = health({ jobs: { backup: run({ at: ago(15), lastGoodAt: ago(15) }), digest: run({ at: ago(5) }) }, syncCheck: check({ at: ago(1) }) })
    expect(jobAlarms(hung, NOW)).toEqual([
      {
        job: 'digest',
        title: 'The hourly digest has stopped.',
        sentence: 'It last ran 5 hours ago, so no digest, due-now nudge or sync check has gone out since.',
        since: `digest-stale:${ago(5)}`,
      },
    ])
  })

  it('an hourly digest whose last run failed', () => {
    const failed = run({ ok: false, failures: ['digest 0000000a: 403'], failureCount: 1, failingSince: ago(3) })
    expect(jobAlarms(health({ jobs: { backup: run(), digest: failed } }), NOW)).toEqual([
      { job: 'digest', title: 'The hourly digest failed:', sentence: 'digest 0000000a: 403, 1 hour ago.', since: `digest-failed:${ago(3)}` },
    ])
  })

  it('counts time the way a person reads it', () => {
    expect([60_000, 45 * 60_000, 2 * HOUR, 47 * HOUR, 49 * HOUR].map(howLong)).toEqual(['1 minute', '45 minutes', '2 hours', '47 hours', '2 days'])
  })
})

describe('opsAlarmOf: Today’s one banner', () => {
  const refused = check({ ok: false, failures: [{ kind: 'habit', reason: 'rejected' }], failingSince: ago(2) }, 'The server refused a test write for habit (rejected), 1 hour ago.')
  const backupFailed = run({ at: ago(15), ok: false, failures: ['storage 503'], failureCount: 1, failingSince: ago(15), lastGoodAt: ago(39) })
  const digestStopped = run({ at: ago(6) })

  it('the sync check’s refusal first, as before, with its own words and no title of its own', () => {
    const h = health({ syncCheck: refused, jobs: { backup: backupFailed, digest: run() } })
    expect(opsAlarmOf(h, NOW)).toEqual(syncAlarmOf(refused, NOW))
    expect(opsAlarmOf(h, NOW)?.title).toBeUndefined()
  })

  it('then the backup, then the digest; each put aside on its own for twelve hours', () => {
    const h = health({ syncCheck: check({ at: ago(6) }), jobs: { backup: backupFailed, digest: digestStopped } })
    expect(opsAlarmOf(h, NOW)?.job).toBe('backup')
    const asideBackup = [{ since: `backup-failed:${ago(15)}`, at: ago(1) }]
    expect(opsAlarmOf(h, NOW, null, asideBackup)?.job).toBe('digest')
    const asideBoth = [...asideBackup, { since: `digest-stale:${ago(6)}`, at: ago(1) }]
    expect(opsAlarmOf(h, NOW, null, asideBoth)).toBeNull()
    // twelve hours on, the backup is back
    expect(opsAlarmOf(h, new Date(Date.parse(ago(1)) + SYNC_ALARM_SNOOZE_MS), null, asideBoth)?.job).toBe('backup')
  })

  it('a new failure after one put aside comes back at once', () => {
    const aside = [{ since: `backup-failed:${ago(15)}`, at: ago(1) }]
    const again = run({ at: ago(0.5), ok: false, failures: ['storage 503'], failureCount: 1, failingSince: ago(0.5) })
    expect(opsAlarmOf(health({ jobs: { backup: again, digest: run() } }), NOW, null, aside)?.job).toBe('backup')
  })
})

describe('the jobs’ dismissals are this device’s own list', () => {
  const saved = new Map<string, string>()
  beforeEach(() => {
    saved.clear()
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the newest eight, one per alarm, and reads as none when it cannot be read', () => {
    expect(readJobAlarmDismissals()).toEqual([])
    for (let i = 0; i < 10; i++) writeJobAlarmDismissal({ since: `backup-failed:${i}`, at: ago(i) })
    writeJobAlarmDismissal({ since: 'backup-failed:9', at: ago(0) })
    const list = readJobAlarmDismissals()
    expect(list).toHaveLength(8)
    expect(list[0]).toEqual({ since: 'backup-failed:9', at: ago(0) })
    expect(list.filter(d => d.since === 'backup-failed:9')).toHaveLength(1)
    saved.set('drafter:job-alarm-dismissed', '{"since":1}')
    expect(readJobAlarmDismissals()).toEqual([])
    vi.stubGlobal('localStorage', undefined)
    expect(readJobAlarmDismissals()).toEqual([])
    expect(() => writeJobAlarmDismissal({ since: 'x', at: ago(0) })).not.toThrow()
  })
})

describe('the banner', () => {
  it('leads with a job’s own title, and with the sync check’s words when it has none', () => {
    const job = renderToStaticMarkup(<SyncAlarmBanner alarm={{ job: 'backup', title: 'Nightly backup failed:', sentence: 'storage 503, 15 hours ago.', since: 's' }} onOpen={() => {}} />)
    expect(job).toContain('<strong>Nightly backup failed:</strong> storage 503, 15 hours ago.')
    expect(job).toContain('>Open Admin → Data</button>')
    const sync = renderToStaticMarkup(<SyncAlarmBanner alarm={{ sentence: 'The server refused…', since: 's' }} />)
    expect(sync).toContain('<strong>Some edits are not reaching the server.</strong>')
  })
})

describe('Admin → Data: the jobs and the errors', () => {
  it('shows each job’s last run, what it did and what failed, with the banner’s own words on top', () => {
    const failed = run({ at: ago(15), ok: false, counts: { snapshots: 1, records: 1204, encrypted: true }, failures: ['a1: storage 503'], failureCount: 2, failingSince: ago(15), lastGoodAt: ago(39) })
    const html = renderToStaticMarkup(<JobsCard health={health({ jobs: { backup: failed, digest: run({ counts: { sent: 3, drafted: 0, subscribers: 2 } }) } })} now={NOW} />)
    expect(html).toContain('admin-health admin-alarm')
    expect(html).toContain('Needs a look')
    expect(html).toContain('<strong>Nightly backup failed:</strong> a1: storage 503 (and 1 more), 15 hours ago.')
    expect(html).toContain('1 snapshot · 1,204 records · encrypted')
    expect(html).toContain('sent 3 · 2 subscribed')
    expect(html).toContain('and 1 more')
    expect(jobSummary('digest', run({ counts: { sent: 0, drafted: 2, subscribers: 0 } }))).toBe('sent 0 · drafted 2 · 0 subscribed')
    // the digest starts Sunday's drafts now, and the background function writes them
    expect(jobSummary('digest', run({ counts: { sent: 1, draftsStarted: 2, subscribers: 1 } }))).toBe('sent 1 · drafts started 2 · 1 subscribed')
  })

  it('reads as running when all is well, and says so when the records cannot be read yet', () => {
    const fine = renderToStaticMarkup(<JobsCard health={health()} now={NOW} />)
    expect(fine).toContain('Running')
    expect(fine).not.toContain('admin-alarm')
    const unread = renderToStaticMarkup(<JobsCard health={{ syncCheck: null, jobs: null }} now={NOW} />)
    expect(unread).toContain('Not recorded')
    expect(unread).toContain('v3.29 migration')
    expect(renderToStaticMarkup(<JobsCard health={null} />)).toContain('Checking…')
  })

  it('lists what devices reported: the message, how often, when last, the platform and build, and the stack folded away', () => {
    const errors: ClientError[] = [
      { id: 'e1', message: "TypeError: Cannot read properties of undefined (reading 'title')", stack: 'at TaskCard (Planner.js:1:2)', count: 1234, firstAt: ago(30), lastAt: ago(2), build: '6ab15c99f00d1234', platform: 'ios', view: 'tasks', path: '/' },
    ]
    const html = renderToStaticMarkup(<ErrorsCard errors={errors} onClear={() => {}} />)
    expect(html).toContain('1 error')
    expect(html).toContain('TypeError: Cannot read properties of undefined (reading &#x27;title&#x27;)')
    expect(html).toContain('1,234×')
    expect(html).toContain('iPhone app · build 6ab15c99f00d · tasks')
    expect(html).toContain('<summary>Stack</summary>')
    expect(html).toContain('at TaskCard (Planner.js:1:2)')
    expect(html).toContain('>Clear</button>')
    expect(html).toContain('never your records or anything you typed')
  })

  it('says when none were reported, and offers nothing to clear', () => {
    const html = renderToStaticMarkup(<ErrorsCard errors={[]} unavailable="It needs the v3.29 migration." onClear={() => {}} />)
    expect(html).toContain('None reported')
    expect(html).toContain('It needs the v3.29 migration.')
    expect(html).not.toContain('>Clear</button>')
  })

  it('sits in Admin → Data, loading on its own', () => {
    const html = renderToStaticMarkup(<Admin initialGroup="data" />)
    const data = html.slice(html.indexOf('settings-section g-data'))
    expect(data).toContain('Scheduled jobs')
    expect(data).toContain('Errors from devices')
    expect(data.indexOf('Scheduled jobs')).toBeLessThan(data.indexOf('Counting rows…'))
  })
})
