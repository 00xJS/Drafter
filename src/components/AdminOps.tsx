import { useEffect, useState, type ReactNode } from 'react'
import { type ClientError, type JobName, type JobRecord, type OpsHealth, clearClientErrors, fetchClientErrors, fetchOpsHealth } from '../ops'
import { BACKUP_STALE_MS, DIGEST_STALE_MS, howLong, jobAlarms } from '../syncalarm'
import { ConfirmButton } from './ConfirmButton'

// Admin → Data's two cards for "is it safe to run" (v3.29): each scheduled
// job's last run, and the errors devices have reported. They fetch for
// themselves (admin.mjs opsHealth, listErrors), so a slow or missing part —
// the error list before its migration, say — never holds up Data's counts.

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'never')

const JOB_TITLES: Record<JobName, string> = { backup: 'Nightly backup', digest: 'Hourly digest' }

function Line({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <li className="admin-stat">
      <span>{label}</span>
      <strong className={tone === 'ok' ? 'sync-ok' : tone === 'warn' ? 'warn' : undefined}>{value}</strong>
    </li>
  )
}

/** A run's counts in words: "2 snapshots · 1,204 records · encrypted", "sent 3 · 2 subscribed". */
export function jobSummary(job: JobName, r: JobRecord): string {
  const n = (k: string) => (typeof r.counts[k] === 'number' ? (r.counts[k] as number) : null)
  const plural = (k: string, one: string) => (n(k) === null ? null : `${n(k)!.toLocaleString('en-US')} ${one}${n(k) === 1 ? '' : 's'}`)
  const parts =
    job === 'backup'
      ? [plural('snapshots', 'snapshot'), plural('records', 'record'), r.counts.encrypted === true ? 'encrypted' : r.counts.encrypted === false ? 'not encrypted' : null]
      : [n('sent') === null ? null : `sent ${n('sent')}`, n('drafted') ? `drafted ${n('drafted')}` : null, n('subscribers') === null ? null : `${n('subscribers')} subscribed`]
  return parts.filter(Boolean).join(' · ')
}

/** One job's lines: its last run, what it did, and what failed. */
function JobLines({ job, record, seenAt }: { job: JobName; record: JobRecord | null | undefined; seenAt?: string | null }) {
  if (!record) {
    return <Line label={JOB_TITLES[job]} value={seenAt ? `No record yet · last seen ${when(seenAt)}` : 'No record yet'} />
  }
  const summary = jobSummary(job, record)
  return (
    <>
      <Line label={JOB_TITLES[job]} value={`${record.ok ? 'Worked' : 'Failed'} · ${when(record.at)}`} tone={record.ok ? 'ok' : 'warn'} />
      {summary && <Line label="…what it did" value={summary} />}
      {job === 'backup' && !record.ok && <Line label="…last run that wrote every snapshot" value={when(record.lastGoodAt)} />}
      {record.failures.map((f, i) => (
        <Line key={i} label={i === 0 ? '…failed' : ''} value={f} tone="warn" />
      ))}
      {record.failureCount > record.failures.length && <Line label="" value={`and ${record.failureCount - record.failures.length} more`} tone="warn" />}
    </>
  )
}

/** Each scheduled job's last run, and the same alarms Today's banner shows the owner. */
export function JobsCard({ health, now = new Date() }: { health: OpsHealth | null; now?: Date }) {
  const alarms = health ? jobAlarms(health, now) : []
  const status = !health ? 'Checking…' : !health.jobs ? 'Not recorded' : alarms.length ? 'Needs a look' : 'Running'
  return (
    <div className={alarms.length ? 'admin-health admin-alarm' : 'admin-health'}>
      <p className="sync-line">
        <strong>Scheduled jobs</strong>
        <span className={!health || !health.jobs ? 'muted' : alarms.length ? 'warn' : 'sync-ok'}>{status}</span>
      </p>
      {alarms.map(a => (
        <p key={a.since} className="field-hint">
          <strong>{a.title}</strong> {a.sentence}
        </p>
      ))}
      {health && (
        <ul className="admin-stats">
          <JobLines job="backup" record={health.jobs?.backup} seenAt={health.lastSnapshotAt} />
          <JobLines job="digest" record={health.jobs?.digest} seenAt={health.syncCheck?.record?.at} />
        </ul>
      )}
      {health && !health.jobs && <p className="field-hint">The jobs could not be read. Their records start once the v3.29 migration is applied.</p>}
      <p className="field-hint">
        The backup runs every night at midnight UTC and the digest every hour. Today shows you a banner when the digest has not run for{' '}
        {howLong(DIGEST_STALE_MS)}, when no backup has worked for {howLong(BACKUP_STALE_MS)}, or when a run failed.
      </p>
    </div>
  )
}

/** "3× · last 22/09/2026, 10:15 · iOS · build 6ab15c99 · home" */
function errorMeta(e: ClientError): string {
  return [
    `${e.count.toLocaleString('en-US')}×`,
    `last ${when(e.lastAt)}`,
    e.platform === 'ios' ? 'iPhone app' : e.platform === 'web' ? 'web' : null,
    e.build ? `build ${e.build.slice(0, 12)}` : null,
    e.view,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * What devices reported, newest first. A row is one error however often it
 * happened: its message, how many times, when last, the build and the
 * platform, and its stack folded away.
 */
export function ErrorsCard({ errors, unavailable, busy, onClear }: { errors: ClientError[] | null; unavailable?: string; busy?: boolean; onClear(): void }) {
  const any = !!errors?.length
  return (
    <div className={any ? 'admin-health admin-alarm' : 'admin-health'}>
      <p className="sync-line">
        <strong>Errors from devices</strong>
        <span className={errors === null ? 'muted' : any ? 'warn' : 'sync-ok'}>
          {errors === null ? 'Checking…' : any ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : 'None reported'}
        </span>
      </p>
      {unavailable && <p className="field-hint">{unavailable}</p>}
      {any && (
        // the wrapping of Settings → Assistants' list: a message is long, and it wraps rather than being cut at 375px
        <ul className="cal-sources admin-users agent-connections">
          {errors!.map(e => (
            <li key={e.id} className="cal-source">
              <div className="cal-source-name">
                {e.message}
                <small>{errorMeta(e)}</small>
                {e.stack && (
                  <details className="admin-optional">
                    <summary>Stack</summary>
                    <div className="md">
                      <pre>
                        <code>{e.stack}</code>
                      </pre>
                    </div>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {any && (
        <div className="check-add">
          <ConfirmButton className="btn" confirmLabel="Clear them all?" onConfirm={onClear}>
            {busy ? 'Clearing…' : 'Clear'}
          </ConfirmButton>
        </div>
      )}
      <p className="field-hint">
        When something breaks, the app sends the error’s message and stack, the build, web or iPhone, and which screen — never your records or anything you typed.
        Only you can see this list. An error nobody hits for 30 days drops off by itself.
      </p>
    </div>
  )
}

/** Both cards, each loading on its own when Admin opens. */
export function AdminOps() {
  const [health, setHealth] = useState<OpsHealth | null>(null)
  const [errors, setErrors] = useState<ClientError[] | null>(null)
  const [unavailable, setUnavailable] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const loadErrors = () =>
    fetchClientErrors().then(
      r => {
        setErrors(r.errors)
        setUnavailable(r.unavailable)
      },
      e => {
        setErrors([])
        setUnavailable((e as Error).message)
      },
    )

  useEffect(() => {
    fetchOpsHealth().then(setHealth, () => setHealth({ syncCheck: null, jobs: null }))
    void loadErrors()
  }, [])

  const clear = async () => {
    setBusy(true)
    try {
      await clearClientErrors()
      await loadErrors()
    } catch (e) {
      setUnavailable((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <JobsCard health={health} />
      <ErrorsCard errors={errors} unavailable={unavailable} busy={busy} onClear={() => void clear()} />
    </>
  )
}
