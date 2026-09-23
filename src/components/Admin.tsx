import { useEffect, useState } from 'react'
import { AdminGroup, AdminStatus, AdminUser, AiTest, BackupList, BackupReport, DataStats, DigestTest, PushTest, SyncCheck, adminAction } from '../admin'
import { siteOrigin } from '../api'
import { isEnvelope, unwrapSnapshot } from '../backupcrypto'
import { saveFile } from '../native'
import { SnapshotFiles, type OpenedSnapshot, type SnapshotLink } from './AdminBackups'
import { AdminOps } from './AdminOps'
import { ConfirmButton } from './ConfirmButton'

const GROUPS: { key: AdminGroup; label: string }[] = [
  { key: 'users', label: 'Users' },
  { key: 'data', label: 'Data' },
  { key: 'backups', label: 'Backups' },
]
type Group = AdminGroup

/** Kinds in the order the app thinks about them; `unknown` is pre-kind legacy rows. */
const KIND_LABELS: [string, string][] = [
  ['task', 'Tasks'],
  ['project', 'Projects'],
  ['person', 'People'],
  ['place', 'Places'],
  ['calendar', 'Calendar sources'],
  ['review', 'Reviews'],
  ['template', 'Templates'],
  ['unknown', 'Legacy rows (no kind)'],
]

type Stats = DataStats & { syncCheck?: SyncCheck }

interface Props {
  /** The section it opens on: Users, unless another is asked for (Today's sync alarm opens Data). */
  initialGroup?: Group
}

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1_048_576).toFixed(1)} MB`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

/**
 * One integration's status. An optional one that is not set up reads "Optional
 * — off", not as a fault, with its setup folded away under "How to turn it on".
 */
function HealthCard({
  title,
  piece,
  optional,
  children,
}: {
  title: string
  piece: { configured: boolean; missing: string[] }
  optional?: boolean
  children?: React.ReactNode
}) {
  const off = !!optional && !piece.configured
  const body = (
    <>
      {!piece.configured && piece.missing.length > 0 && (
        <p className="field-hint">
          Missing on the host: <code>{piece.missing.join(', ')}</code>.
        </p>
      )}
      {children}
    </>
  )
  return (
    <div className="admin-health">
      <p className="sync-line">
        <strong>{title}</strong>
        <span className={piece.configured ? 'sync-ok' : off ? 'muted' : 'warn'}>{piece.configured ? 'Configured' : off ? 'Optional — off' : 'Not configured'}</span>
      </p>
      {off ? (
        <details className="admin-optional">
          <summary>How to turn it on</summary>
          {body}
        </details>
      ) : (
        body
      )}
    </div>
  )
}

/** One row of the compact health lists (Data, Backups). */
function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <li className="admin-stat">
      <span>{label}</span>
      <strong className={tone === 'ok' ? 'sync-ok' : tone === 'warn' ? 'warn' : undefined}>{value}</strong>
    </li>
  )
}

/** Admin → Data's card for the hourly sync check: what it last found, the kinds that failed, and a way to run it now. */
function SyncCheckCard({ check, busy, checking, onCheck }: { check?: SyncCheck; busy: boolean; checking: boolean; onCheck(): void }) {
  const record = check?.record ?? null
  return (
    <div className={record && !record.ok ? 'admin-health admin-alarm' : 'admin-health'}>
      <p className="sync-line">
        <strong>Sync check</strong>
        <span className={record?.ok ? 'sync-ok' : 'warn'}>{!check ? 'Unknown' : !record ? 'Not run yet' : record.ok ? 'Passing' : 'Failing'}</span>
      </p>
      <p className="field-hint">{check?.sentence ?? 'The server did not report a sync check.'}</p>
      {record && record.failures.length > 0 && (
        <ul className="admin-stats">
          {record.failures.map((f, i) => (
            <Stat key={`${f.kind}-${i}`} label={f.kind ?? '(no kind)'} value={f.reason} tone="warn" />
          ))}
        </ul>
      )}
      <div className="check-add">
        <button className="btn" disabled={busy} onClick={onCheck}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <p className="field-hint">
        Every hour the digest writes one test row of each kind through <code>sync_posts</code> and rolls it back, so nothing is kept. If the server refuses one, you
        are told through the digest’s push or email, at most every 12 hours.
      </p>
    </div>
  )
}

function TestLine({ ok, detail, error }: { ok: boolean; detail?: string; error?: string | null }) {
  return (
    <p className="admin-test">
      <span className={ok ? 'sync-ok' : 'warn'}>{ok ? 'OK' : 'Failed'}</span>
      {detail && <small> · {detail}</small>}
      {error && <small className="admin-test-error">{error}</small>}
    </p>
  )
}

export function Admin({ initialGroup = 'users' }: Props) {
  const [group, setGroup] = useState<Group>(initialGroup)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null)
  const [status, setStatus] = useState<AdminStatus | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [backups, setBackups] = useState<BackupList | null>(null)
  const [backupReport, setBackupReport] = useState<BackupReport | null>(null)
  const [link, setLink] = useState<SnapshotLink | null>(null)
  const [aiTest, setAiTest] = useState<AiTest | null>(null)
  const [pushTest, setPushTest] = useState<PushTest | null>(null)
  const [digestTest, setDigestTest] = useState<DigestTest | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [createEmail, setCreateEmail] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [resetEmail, setResetEmail] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [linkOut, setLinkOut] = useState('')
  const [copied, setCopied] = useState(false)
  /** The account a reset mail has just gone to, so the note under it names them. */
  const [sentTo, setSentTo] = useState('')
  /** A snapshot fetched for reading, and its contents once they can be read. */
  const [opened, setOpened] = useState<OpenedSnapshot | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const busy = pending !== ''

  const refreshUsers = () =>
    adminAction<{ users: AdminUser[]; ownerEmail: string | null }>('listUsers').then(r => {
      setUsers(r.users)
      setOwnerEmail(r.ownerEmail)
    })
  const refreshStatus = () => adminAction<AdminStatus>('status').then(setStatus)
  const refreshStats = () => adminAction<Stats>('dataStats').then(setStats)
  const refreshBackups = () => adminAction<BackupList>('listBackups').then(setBackups)

  useEffect(() => {
    // load every panel up front: the whole point of Data and Backups is that
    // they answer "is my data still there?" the moment Admin opens
    Promise.all([refreshUsers(), refreshStatus(), refreshStats(), refreshBackups()]).catch(e => setError((e as Error).message))
  }, [])

  const runNamed = async (name: string, fn: () => Promise<unknown>) => {
    setPending(name)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending('')
    }
  }
  const run = (fn: () => Promise<unknown>) => runNamed('busy', fn)

  const copyLink = async (link: string) => {
    setLinkOut(link)
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* field is selectable */
    }
  }

  /** Link only: a reset link to copy. Supabase keeps one per account, so this cancels any reset email sent before it. */
  const makeResetLink = () =>
    run(async () => {
      const r = await adminAction<{ actionLink?: string | null }>('resetPassword', { email: resetEmail })
      setSentTo('')
      if (r.actionLink) await copyLink(r.actionLink)
    })

  /**
   * Read a snapshot back. The server never decrypts one (see
   * netlify/functions/lib/backupcrypto.mjs), so the file is fetched through
   * its signed link and opened here, with a passphrase that stays in this
   * browser. A snapshot written before encryption was turned on opens with no
   * passphrase at all. Whatever happens is said under the snapshot's own row.
   */
  const readSnapshot = async (path: string) => {
    setPending(`read:${path}`)
    setPassphrase('')
    try {
      const r = await adminAction<{ url: string }>('downloadBackup', { path })
      const res = await fetch(r.url)
      if (!res.ok) throw new Error(`The snapshot could not be fetched (${res.status}). Try again.`)
      const raw: unknown = await res.json()
      setOpened({ path, raw, snapshot: isEnvelope(raw) ? null : await unwrapSnapshot(raw, '') })
    } catch (e) {
      setOpened({ path, raw: null, snapshot: null, error: (e as Error).message })
    } finally {
      setPending('')
    }
  }

  const unlockSnapshot = async () => {
    if (!opened) return
    try {
      setOpened({ ...opened, snapshot: await unwrapSnapshot(opened.raw, passphrase), error: undefined })
      setPassphrase('')
    } catch (e) {
      setOpened({ ...opened, error: (e as Error).message })
    }
  }

  const saveSnapshot = () => {
    if (!opened?.snapshot) return
    const name = `${opened.path.split('/').pop()?.replace(/\.json$/, '') ?? 'snapshot'}-readable.json`
    saveFile(name, new Blob([JSON.stringify(opened.snapshot, null, 2)], { type: 'application/json' })).catch(e => setOpened({ ...opened, error: (e as Error).message }))
  }

  const closeSnapshot = () => {
    setOpened(null)
    setPassphrase('')
  }

  const download = async (path: string) => {
    setPending(`link:${path}`)
    try {
      const r = await adminAction<{ url: string }>('downloadBackup', { path })
      // the link is also shown under the row: opening after an await can trip a popup blocker
      setLink({ path, url: r.url })
      window.open(r.url, '_blank', 'noopener')
    } catch (e) {
      setLink({ path, url: '', error: (e as Error).message })
    } finally {
      setPending('')
    }
  }

  const isOwnerRow = (u: AdminUser) => !!ownerEmail && u.email.toLowerCase() === ownerEmail.toLowerCase()

  return (
    /* A screen, not a dialog: AdminScreen draws the header and the ‹ Back. */
    <div className={`settings-body showing-${group}`}>
        <nav className="settings-nav" role="tablist" aria-label="Admin sections">
          {GROUPS.map(g => (
            <button key={g.key} className={group === g.key ? 'seg on' : 'seg'} onClick={() => setGroup(g.key)} role="tab" aria-selected={group === g.key}>
              {g.label}
            </button>
          ))}
        </nav>

        <section className="settings-section g-users">
          <h3>Accounts</h3>
          <p className="field-hint">Who can sign in to this planner, and their passwords. Household sharing still happens in each person’s own Settings.</p>

          <div className="admin-health">
            <p className="sync-line">
              <strong>Site owner</strong>
              <span className={status?.owner.configured ? 'sync-ok' : 'warn'}>{status ? (status.owner.email ?? 'Not set') : 'Checking…'}</span>
            </p>
            {/* the long version only when it is not set up, or on request:
                once it works, this is a line, not a page (v3.25) */}
            {status && !status.owner.configured ? (
              <p className="field-hint">
                Nothing owner-scoped works until <code>app_config.owner_email</code> exists — every session is refused read and write on <code>posts</code>, and this panel
                answers 501. Bootstrap it once with the service-role key: <code>POST /rest/v1/app_config</code> with{' '}
                <code>{'{"key":"owner_email","value":"you@example.com"}'}</code>.
              </p>
            ) : (
              <details className="admin-optional">
                <summary>How ownership works</summary>
                <p className="field-hint">
                  Owner-only actions compare your session email against <code>app_config.owner_email</code>. Handing ownership over means rewriting that row with the
                  service-role key — there is deliberately no in-app way to do it.
                </p>
              </details>
            )}
          </div>

          <h4>Add someone</h4>
          <div className="check-add">
            <input value={createEmail} onChange={e => setCreateEmail(e.target.value)} placeholder="Their email" type="email" />
            <input value={createPassword} onChange={e => setCreatePassword(e.target.value)} placeholder="Temporary password" type="text" autoComplete="off" />
            <button
              className="btn primary"
              disabled={busy || !createEmail.trim() || createPassword.length < 8}
              onClick={() =>
                run(async () => {
                  await adminAction('createUser', { email: createEmail, password: createPassword })
                  setCreateEmail('')
                  setCreatePassword('')
                  await refreshUsers()
                })
              }
            >
              Create
            </button>
          </div>
          <details className="admin-optional">
            <summary>Invite them instead</summary>
            <p className="field-hint">Makes a one-time link that sets up their account when they open it, so there is no temporary password to pass on.</p>
            <div className="check-add">
              <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="Their email" type="email" />
              <button
                className="btn"
                disabled={busy || !inviteEmail.trim()}
                onClick={() =>
                  run(async () => {
                    const r = await adminAction<{ actionLink: string | null }>('inviteUser', { email: inviteEmail })
                    setInviteEmail('')
                    if (r.actionLink) await copyLink(r.actionLink)
                    await refreshUsers()
                  })
                }
              >
                Generate invite link
              </button>
            </div>
          </details>

          <h4>Reset someone's password</h4>
          <p className="field-hint">
            Pick the account, then send them the email. Most of the time that is the whole job — they follow the link in it, choose a password and are signed in. Link
            only makes a link for you to pass on yourself instead, for when the email does not come.
          </p>
          <div className="check-add">
            <label className="people-sort">
              Account
              <select value={resetEmail} onChange={e => setResetEmail(e.target.value)}>
                <option value="">Choose…</option>
                {(users ?? []).map(u => (
                  <option key={u.id} value={u.email}>
                    {u.email}
                    {isOwnerRow(u) ? ' (owner)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn primary"
              disabled={busy || !resetEmail.trim()}
              onClick={() =>
                run(async () => {
                  await adminAction<{ mode: string }>('resetPassword', {
                    email: resetEmail,
                    send: true,
                    // the link has to come back to the hosted site, not to
                    // whatever Site URL the Supabase project was set up with —
                    // and never to the iOS shell's own capacitor:// origin
                    redirectTo: siteOrigin(),
                  })
                  // no link comes back: one made now would cancel the emailed one
                  setLinkOut('')
                  setSentTo(resetEmail)
                })
              }
            >
              Send reset email
            </button>
            {sentTo !== '' && sentTo === resetEmail && !busy ? (
              <ConfirmButton className="btn" confirmLabel="Cancels the emailed link — click again" onConfirm={() => void makeResetLink()}>
                Link only
              </ConfirmButton>
            ) : (
              <button className="btn" disabled={busy || !resetEmail.trim()} onClick={() => void makeResetLink()}>
                Link only
              </button>
            )}
          </div>
          {sentTo && (
            <p className="sync-ok">
              Sent to {sentTo}. The link in that email is the one to use. Supabase's built-in sender allows only a few emails an hour, so if nothing has come in a few
              minutes, use Link only — but making a link cancels the one in the email.
            </p>
          )}

          <details className="admin-optional">
            <summary>Set a password myself</summary>
            <p className="field-hint">
              Types a password straight onto the account, with no email and no link. For when somebody is standing next to you; tell it to them out loud and have them
              change it under Settings → You.
            </p>
            <div className="check-add">
              <input value={resetPassword} onChange={e => setResetPassword(e.target.value)} placeholder="New password" type="text" autoComplete="off" />
              <button
                className="btn"
                disabled={busy || !resetEmail.trim() || resetPassword.trim().length < 8}
                onClick={() =>
                  run(async () => {
                    await adminAction('resetPassword', { email: resetEmail, password: resetPassword })
                    setResetPassword('')
                    setSentTo('')
                    setLinkOut(`Password set for ${resetEmail}.`)
                  })
                }
              >
                Set it
              </button>
            </div>
          </details>

          {linkOut && (
            <div className="copy-row">
              <input readOnly value={linkOut} onFocus={e => e.currentTarget.select()} />
              {linkOut.startsWith('http') && (
                <button className="btn" onClick={() => copyLink(linkOut)}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
          )}

          <h4>Accounts on this site</h4>
          <details className="admin-optional">
            <summary>What Disable and Delete each do</summary>
            <p className="field-hint">
              Deleting an account hands their shared records (tasks, projects, people, places, the kitchen, events) to you and deletes their personal ones (journal,
              reviews, calendar subscriptions, habits, routines, snoozes) together with their history. Backup snapshots already taken are left as they are. Disable
              instead if you only want to lock someone out.
            </p>
          </details>
          {users ? (
            <ul className="cal-sources admin-users">
              {users.map(u => (
                <li key={u.id} className="cal-source">
                  <span className="cal-source-name">
                    {u.email || u.id}
                    {isOwnerRow(u) && (
                      <>
                        {' '}
                        <small className="tag">owner</small>
                      </>
                    )}
                    {u.disabled && <small className="warn"> · disabled</small>}
                    {u.lastSignInAt && <small> · last sign-in {new Date(u.lastSignInAt).toLocaleDateString()}</small>}
                  </span>
                  <ConfirmButton
                    className="btn subtle danger"
                    confirmLabel={u.disabled ? 'Enable?' : 'Disable?'}
                    onConfirm={() =>
                      run(async () => {
                        await adminAction('setDisabled', { userId: u.id, disabled: !u.disabled })
                        await refreshUsers()
                      })
                    }
                  >
                    {u.disabled ? 'Enable' : 'Disable'}
                  </ConfirmButton>
                  {!isOwnerRow(u) && (
                    <ConfirmButton
                      className="btn subtle danger"
                      confirmLabel="Delete for good?"
                      title={`Delete ${u.email}. Their shared records become yours; their journal, habits and other personal records are deleted, and their wardrobe photos with them.`}
                      onConfirm={() =>
                        run(async () => {
                          const r = await adminAction<{ email: string | null; reassigned: number; deleted: number; historyDeleted: number; photosDeleted?: number }>('deleteUser', {
                            userId: u.id,
                          })
                          setLinkOut(
                            `Deleted ${r.email ?? u.email}. ${r.reassigned} shared record(s) are now yours; ${r.deleted} personal record(s), ${r.historyDeleted} history row(s) and ${r.photosDeleted ?? 0} wardrobe photo(s) were deleted.`,
                          )
                          await Promise.all([refreshUsers(), refreshStats()])
                        })
                      }
                    >
                      Delete
                    </ConfirmButton>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">Loading users…</p>
          )}
        </section>

        <section className="settings-section g-data">
          <h3>Data</h3>
          <p className="field-hint">
            Row counts read straight from the database with the service key, so they bypass every policy and show what is really there. Only tallies are returned — never
            record contents.
          </p>
          {/* the scheduled jobs' last runs and what devices reported (v3.29); each loads on its own */}
          <AdminOps />
          {stats ? (
            <>
              <SyncCheckCard
                check={stats.syncCheck}
                busy={busy}
                checking={pending === 'syncCheck'}
                onCheck={() =>
                  runNamed('syncCheck', async () => {
                    const check = await adminAction<SyncCheck>('runSyncCanary')
                    setStats(s => (s ? { ...s, syncCheck: check } : s))
                  })
                }
              />
              <ul className="admin-stats">
                <Stat label="Live records" value={stats.live} tone={stats.live > 0 ? 'ok' : 'warn'} />
                {KIND_LABELS.filter(([k]) => (stats.kinds[k] ?? 0) > 0 || k === 'task').map(([k, label]) => (
                  <Stat key={k} label={label} value={stats.kinds[k] ?? 0} />
                ))}
                {Object.keys(stats.kinds)
                  .filter(k => !KIND_LABELS.some(([known]) => known === k) && stats.kinds[k] > 0)
                  .map(k => (
                    <Stat key={k} label={k} value={stats.kinds[k]} />
                  ))}
              </ul>
              <ul className="admin-stats">
                <Stat label="Deletion markers (tombstones)" value={stats.tombstones} />
                <Stat label="…already purged (awaiting hard delete)" value={stats.purged} />
                <Stat label="Unowned rows (legacy, read as the owner’s)" value={stats.unowned} />
                <Stat label="Version history rows" value={stats.historyRows ?? '—'} tone={stats.historyRows === 0 ? 'warn' : undefined} />
                <Stat label="Newest server sync" value={when(stats.newestSyncedAt)} tone={stats.newestSyncedAt ? undefined : 'warn'} />
                <Stat label="Households / members" value={`${stats.households ?? '—'} / ${stats.householdMembers ?? '—'}`} />
              </ul>
              <h4>Rows per account</h4>
              <ul className="cal-sources admin-users">
                {stats.users.map(u => (
                  <li key={u.userId ?? 'unowned'} className="cal-source">
                    <span className="cal-source-name">{u.email ?? (u.userId ? `${u.userId.slice(0, 8)}… (no account)` : 'No owner (legacy rows)')}</span>
                    <span className="cal-source-status">
                      {u.live} live{u.deleted > 0 && <small> · {u.deleted} deleted</small>}
                    </span>
                  </li>
                ))}
              </ul>
              {stats.historyRows === 0 && (
                <p className="field-hint">
                  No version history yet. <code>posts_history</code> only fills when an existing record’s <code>data</code> changes, and the daily backup drops rows older
                  than 60 days — zero here means either nothing has been edited since the table was added, or the purge has caught up.
                </p>
              )}
            </>
          ) : (
            <p className="field-hint">Counting rows…</p>
          )}
        </section>

        <section className="settings-section g-backups">
          <h3>Backups</h3>
          <p className="field-hint">
            A snapshot is one JSON object per account in the private <code>media</code> bucket at <code>backups/&lt;user id&gt;/&lt;date&gt;.json</code>. The scheduled
            daily job and the button below run the identical pass, so “Back up now” writes exactly what the schedule would have.
          </p>
          <div className={backupReport && backupReport.encrypted === false ? 'admin-health admin-alarm' : 'admin-health'}>
            <p className="sync-line">
              <strong>Encryption</strong>
              <span className={backupReport?.encrypted ? 'sync-ok' : 'muted'}>
                {backupReport === null ? 'Run a backup to see' : backupReport.encrypted ? 'AES-256-GCM' : 'Off — snapshots are plain JSON'}
              </span>
            </p>
            <p className="field-hint">
              A snapshot holds everything one account has, journal included. With <code>BACKUP_PASSPHRASE</code> set on Netlify each one is encrypted before it is
              written, with a fresh salt, so the service key and a signed link are no longer enough to read anybody's. <strong>The passphrase is the only way back
              in</strong> — the server never keeps a copy it could decrypt with, so losing it means losing every snapshot written after it was set. Keep it where you
              keep the other keys, and read one back with <em>Read it</em> below once, now, rather than the night you need it.
            </p>
          </div>

          {backups ? (
            <>
              {backups.totalFiles === 0 ? (
                <div className="admin-health admin-alarm">
                  <p className="sync-line">
                    <strong>Last backup</strong>
                    <span className="warn">Never — the bucket holds no snapshots</span>
                  </p>
                  <p className="field-hint">
                    The daily job is scheduled but nothing has landed, so there is currently no snapshot to restore from. Run one now, then check back tomorrow to confirm
                    the schedule is firing.
                  </p>
                </div>
              ) : (
                <ul className="admin-stats">
                  <Stat label="Last backup" value={when(backups.lastBackupAt)} tone="ok" />
                  <Stat label="Snapshots stored" value={backups.totalFiles} />
                  <Stat label="Total size" value={bytes(backups.totalBytes)} />
                  <Stat label="Kept per account" value={`newest ${backups.keep}`} />
                </ul>
              )}

              <div className="check-add">
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    runNamed('runBackup', async () => {
                      setBackupReport(await adminAction<BackupReport>('runBackup'))
                      await Promise.all([refreshBackups(), refreshStats()])
                    })
                  }
                >
                  {pending === 'runBackup' ? 'Backing up…' : 'Back up now'}
                </button>
              </div>

              {backupReport && (
                <div className="admin-health">
                  <p className="sync-line">
                    <strong>Wrote {backupReport.date}</strong>
                    <span className={backupReport.failures.length ? 'warn' : 'sync-ok'}>
                      {backupReport.users.length} snapshot{backupReport.users.length === 1 ? '' : 's'}
                    </span>
                  </p>
                  <ul className="admin-stats">
                    {backupReport.users.map(u => (
                      <Stat key={u.userId} label={u.path} value={`${u.items} records · ${bytes(u.bytes)}`} />
                    ))}
                    {backupReport.unowned > 0 && <Stat label="Unowned rows skipped (no account to restore into)" value={backupReport.unowned} />}
                    <Stat label="History rows purged (60d)" value={backupReport.historyPurged ?? '—'} />
                    <Stat label="Unused wardrobe photos deleted (90d)" value={backupReport.photosDeleted ?? '—'} />
                    <Stat label="Purged tombstones hard-deleted (90d)" value={backupReport.tombstonesPurged ?? '—'} />
                  </ul>
                  {backupReport.failures.length > 0 && <p className="warn">{backupReport.failures.join(' | ')}</p>}
                </div>
              )}

              <SnapshotFiles
                users={backups.users}
                busy={busy}
                pending={pending}
                opened={opened}
                link={link}
                passphrase={passphrase}
                onPassphrase={setPassphrase}
                onRead={readSnapshot}
                onDownload={download}
                onUnlock={unlockSnapshot}
                onSave={saveSnapshot}
                onClose={closeSnapshot}
              />
              <p className="field-hint">Download links are signed for five minutes; the bucket itself stays private.</p>
            </>
          ) : (
            <p className="field-hint">Listing snapshots…</p>
          )}
        </section>

        <section className="settings-section g-data admin-integrations">
          <details>
            <summary>
              <h3>Integration health</h3>
            </summary>
          <p className="field-hint">
            Host environment setup, set up once and then left alone — which is why it folds away here rather than holding a tab of its own. Values never leave the
            server; only configured / missing names are shown. The Test buttons make a real call and report the latency or the error.
          </p>

          {status ? (
            <>
              <HealthCard title="iOS push (APNs)" piece={status.apns} optional>
                {!status.apns.configured && (
                  <p className="field-hint">
                    Set <code>APNS_KEY_ID</code>, <code>APNS_TEAM_ID</code>, <code>APNS_PRIVATE_KEY</code> and <code>APNS_BUNDLE_ID</code> on Netlify. Optional{' '}
                    <code>APNS_ENV=sandbox</code> for builds run from Xcode.
                  </p>
                )}
              </HealthCard>

              <HealthCard title="Web push (VAPID)" piece={status.vapid} optional>
                {!status.vapid.configured && (
                  <p className="field-hint">
                    Set <code>VAPID_PUBLIC_KEY</code> and <code>VAPID_PRIVATE_KEY</code> on Netlify (run <code>npx web-push generate-vapid-keys</code> for the pair). Optional{' '}
                    <code>VAPID_SUBJECT</code> (mailto: or https:).
                  </p>
                )}
                <div className="check-add">
                  <button className="btn" disabled={busy} onClick={() => runNamed('testPush', async () => setPushTest(await adminAction<PushTest>('testPush')))}>
                    {pending === 'testPush' ? 'Sending…' : 'Send test push'}
                  </button>
                </div>
                <p className="field-hint">Goes to every device subscribed on this account, browser and iOS alike. Dead endpoints are dropped as they are found.</p>
                {pushTest && (
                  <>
                    <TestLine ok={pushTest.ok} detail={pushTest.latencyMs != null ? `${pushTest.latencyMs} ms` : undefined} error={pushTest.error} />
                    {pushTest.results?.map(r => (
                      <p key={r.endpoint} className="field-hint">
                        <span className={r.ok ? 'sync-ok' : 'warn'}>{r.status}</span> {r.endpoint}
                        {r.error && <> — {r.error}</>}
                      </p>
                    ))}
                  </>
                )}
              </HealthCard>

              <HealthCard title="Google Calendar" piece={status.google} optional>
                {!status.google.configured && (
                  <p className="field-hint">
                    Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on Netlify. The OAuth client's redirect URI must be{' '}
                    <code>{status.google.redirectUri}</code>.
                  </p>
                )}
              </HealthCard>

              <HealthCard title="Outlook / Microsoft 365" piece={status.microsoft} optional>
                {!status.microsoft.configured && (
                  <p className="field-hint">
                    Set <code>MICROSOFT_CLIENT_ID</code> and <code>MICROSOFT_CLIENT_SECRET</code> on Netlify. In the Azure portal register an app that allows{' '}
                    <em>any organizational directory and personal Microsoft accounts</em>, with the redirect URI <code>{status.microsoft.redirectUri}</code>.
                  </p>
                )}
              </HealthCard>

              <HealthCard title="AI assist" piece={status.ai}>
                <p className="field-hint">
                  The ✨ features (break a task into steps, suggest tags, refine a description) run through the site's server-side proxy — configure{' '}
                  <code>NVIDIA_API_KEY</code> (free from build.nvidia.com) or <code>ANTHROPIC_API_KEY</code> in the host environment (Netlify), and optionally a second NVIDIA
                  key, <code>NVIDIA_API_KEY_2</code>, which scheduled work uses first; with two, Test AI asks each key on its own as well. No key is ever stored in the
                  browser.
                  {status.ai.configured && (
                    <>
                      {' '}
                      Currently using {status.ai.nvidia ? (status.ai.nvidiaKeys === 2 ? 'NVIDIA (two keys)' : 'NVIDIA') : null}
                      {status.ai.nvidia && status.ai.anthropic ? ' (Anthropic also set)' : null}
                      {!status.ai.nvidia && status.ai.anthropic ? 'Anthropic' : null}.
                    </>
                  )}
                </p>
                <div className="check-add">
                  <button className="btn" disabled={busy} onClick={() => runNamed('testAi', async () => setAiTest(await adminAction<AiTest>('testAi')))}>
                    {pending === 'testAi' ? 'Asking…' : 'Test AI'}
                  </button>
                </div>
                {aiTest && (
                  <>
                    <TestLine
                      ok={aiTest.ok}
                      detail={[aiTest.provider, `${aiTest.latencyMs} ms`, aiTest.sample && `replied “${aiTest.sample}”`].filter(Boolean).join(' · ')}
                      error={aiTest.error}
                    />
                    {aiTest.keys?.map(k => (
                      <p key={k.name} className="field-hint">
                        <span className={k.ok ? 'sync-ok' : 'warn'}>{k.ok ? 'OK' : 'Failed'}</span> <code>{k.name}</code> · {k.latencyMs} ms
                        {k.error && <> — {k.error}</>}
                      </p>
                    ))}
                  </>
                )}
              </HealthCard>

              <HealthCard title="GitHub" piece={status.github} optional>
                <p className="field-hint">
                  GitHub link cards use <code>GITHUB_TOKEN</code> the same way. Scope <code>project</code> for Projects (the sync reads and writes boards); repo/issues write for status write-back.
                </p>
              </HealthCard>

              <HealthCard title="Digest email (Resend)" piece={status.resend} optional>
                {!status.resend.configured && (
                  <p className="field-hint">
                    Morning digest email needs <code>RESEND_API_KEY</code> on the host.
                  </p>
                )}
                <div className="check-add">
                  <button className="btn" disabled={busy} onClick={() => runNamed('previewDigest', async () => setDigestTest(await adminAction<DigestTest>('runDigest')))}>
                    {pending === 'previewDigest' ? 'Building…' : 'Preview my digest'}
                  </button>
                  {digestTest && digestTest.lines.length > 0 && (
                    <ConfirmButton
                      className="btn"
                      confirmLabel="Send it?"
                      onConfirm={() => runNamed('sendDigest', async () => setDigestTest(await adminAction<DigestTest>('runDigest', { send: true })))}
                    >
                      {pending === 'sendDigest' ? 'Sending…' : 'Send it now'}
                    </ConfirmButton>
                  )}
                </div>
                <p className="field-hint">
                  Preview builds your own digest from live records without sending anything. A real send goes out immediately and deliberately leaves the daily watermark
                  alone, so the scheduled morning digest still arrives.
                </p>
                {digestTest && (
                  <>
                    <TestLine
                      ok={!digestTest.error}
                      detail={[
                        digestTest.sent ? `sent to ${digestTest.pushed ?? 0} device(s)${digestTest.emailed ? ' + email' : ''}` : 'preview only',
                        `${digestTest.timezone} · ${String(digestTest.digestHour).padStart(2, '0')}:00`,
                        `last delivered ${digestTest.lastDigestDay ?? 'never'}`,
                      ].join(' · ')}
                      error={digestTest.error}
                    />
                    {digestTest.lines.length ? (
                      digestTest.lines.map(l => (
                        <p key={l} className="field-hint">
                          {l}
                        </p>
                      ))
                    ) : (
                      <p className="field-hint">Nothing due, no occasions and nobody to catch up with — the digest would stay silent today.</p>
                    )}
                  </>
                )}
              </HealthCard>
            </>
          ) : (
            <p className="field-hint">Checking integrations…</p>
          )}
          </details>
        </section>

        {error && <p className="warn">{error}</p>}
    </div>
  )
}
