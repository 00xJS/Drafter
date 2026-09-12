import { useEffect, useState } from 'react'
import { AdminStatus, AdminUser, AiTest, BackupList, BackupReport, DataStats, DigestTest, PushTest, adminAction } from '../admin'
import { ConfirmButton } from './ConfirmButton'

const GROUPS = [
  { key: 'users', label: 'Users' },
  { key: 'data', label: 'Data' },
  { key: 'backups', label: 'Backups' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'domains', label: 'Domains' },
] as const
type Group = (typeof GROUPS)[number]['key']

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

interface Props {
  onClose(): void
}

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1_048_576).toFixed(1)} MB`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

function HealthCard({
  title,
  piece,
  children,
}: {
  title: string
  piece: { configured: boolean; missing: string[] }
  children?: React.ReactNode
}) {
  return (
    <div className="admin-health">
      <p className="sync-line">
        <strong>{title}</strong>
        <span className={piece.configured ? 'sync-ok' : 'warn'}>{piece.configured ? 'Configured' : 'Not configured'}</span>
      </p>
      {!piece.configured && piece.missing.length > 0 && (
        <p className="field-hint">
          Missing on the host: <code>{piece.missing.join(', ')}</code>.
        </p>
      )}
      {children}
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

function TestLine({ ok, detail, error }: { ok: boolean; detail?: string; error?: string | null }) {
  return (
    <p className="admin-test">
      <span className={ok ? 'sync-ok' : 'warn'}>{ok ? 'OK' : 'Failed'}</span>
      {detail && <small> · {detail}</small>}
      {error && <small className="admin-test-error">{error}</small>}
    </p>
  )
}

export function Admin({ onClose }: Props) {
  const [group, setGroup] = useState<Group>('users')
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null)
  const [status, setStatus] = useState<AdminStatus | null>(null)
  const [stats, setStats] = useState<DataStats | null>(null)
  const [backups, setBackups] = useState<BackupList | null>(null)
  const [backupReport, setBackupReport] = useState<BackupReport | null>(null)
  const [downloadUrl, setDownloadUrl] = useState('')
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
  const busy = pending !== ''

  const refreshUsers = () =>
    adminAction<{ users: AdminUser[]; ownerEmail: string | null }>('listUsers').then(r => {
      setUsers(r.users)
      setOwnerEmail(r.ownerEmail)
    })
  const refreshStatus = () => adminAction<AdminStatus>('status').then(setStatus)
  const refreshStats = () => adminAction<DataStats>('dataStats').then(setStats)
  const refreshBackups = () => adminAction<BackupList>('listBackups').then(setBackups)

  useEffect(() => {
    setError('')
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

  const download = (path: string) =>
    runNamed(path, async () => {
      const r = await adminAction<{ url: string }>('downloadBackup', { path })
      // the link is also shown below: opening after an await can trip a popup blocker
      setDownloadUrl(r.url)
      window.open(r.url, '_blank', 'noopener')
    })

  const isOwnerRow = (u: AdminUser) => !!ownerEmail && u.email.toLowerCase() === ownerEmail.toLowerCase()

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="Admin">
        <header className="modal-head">
          <h2>Admin</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className={`modal-body settings-body showing-${group}`}>
          <nav className="settings-nav" role="tablist" aria-label="Admin sections">
            {GROUPS.map(g => (
              <button key={g.key} className={group === g.key ? 'seg on' : 'seg'} onClick={() => setGroup(g.key)} role="tab" aria-selected={group === g.key}>
                {g.label}
              </button>
            ))}
          </nav>

          <section className="settings-section g-users">
            <h3>Accounts</h3>
            <p className="field-hint">Create or invite people who will use this planner. Household sharing still happens in each person’s Settings.</p>

            <div className="admin-health">
              <p className="sync-line">
                <strong>Site owner</strong>
                <span className={status?.owner.configured ? 'sync-ok' : 'warn'}>{status ? (status.owner.email ?? 'Not set') : 'Checking…'}</span>
              </p>
              {status && !status.owner.configured ? (
                <p className="field-hint">
                  Nothing owner-scoped works until <code>app_config.owner_email</code> exists — every session is refused read and write on <code>posts</code>, and this panel
                  answers 501. Bootstrap it once with the service-role key: <code>POST /rest/v1/app_config</code> with{' '}
                  <code>{'{"key":"owner_email","value":"you@example.com"}'}</code>.
                </p>
              ) : (
                <p className="field-hint">
                  Owner-only actions compare your session email against <code>app_config.owner_email</code>. Handing ownership over means rewriting that row with the
                  service-role key — there is deliberately no in-app way to do it.
                </p>
              )}
            </div>

            <h4>Create account</h4>
            <div className="check-add">
              <input value={createEmail} onChange={e => setCreateEmail(e.target.value)} placeholder="Email" type="email" />
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

            <h4>Invite by email</h4>
            <div className="check-add">
              <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="Email" type="email" />
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

            <h4>Reset password</h4>
            <div className="check-add">
              <input value={resetEmail} onChange={e => setResetEmail(e.target.value)} placeholder="Email" type="email" />
              <input value={resetPassword} onChange={e => setResetPassword(e.target.value)} placeholder="New password (optional)" type="text" autoComplete="off" />
              <button
                className="btn"
                disabled={busy || !resetEmail.trim()}
                onClick={() =>
                  run(async () => {
                    const payload: Record<string, unknown> = { email: resetEmail }
                    if (resetPassword.trim()) payload.password = resetPassword
                    const r = await adminAction<{ actionLink?: string | null; mode: string }>('resetPassword', payload)
                    setResetPassword('')
                    if (r.actionLink) await copyLink(r.actionLink)
                    else setLinkOut(r.mode === 'set' ? `Password updated for ${resetEmail}.` : '')
                  })
                }
              >
                {resetPassword.trim() ? 'Set password' : 'Recovery link'}
              </button>
            </div>

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

            <h4>Users</h4>
            <p className="field-hint">
              Deleting an account hands their shared records (tasks, projects, people, places, the kitchen, events) to you and deletes their personal ones (journal,
              reviews, calendar subscriptions, habits, routines) together with their history. Backup snapshots already taken are left as they are. Disable instead if you
              only want to lock someone out.
            </p>
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
                        title={`Delete ${u.email}. Their shared records become yours; their journal, habits and other personal records are deleted.`}
                        onConfirm={() =>
                          run(async () => {
                            const r = await adminAction<{ email: string | null; reassigned: number; deleted: number; historyDeleted: number }>('deleteUser', { userId: u.id })
                            setLinkOut(
                              `Deleted ${r.email ?? u.email}. ${r.reassigned} shared record(s) are now yours; ${r.deleted} personal record(s) and ${r.historyDeleted} history row(s) were deleted.`,
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
            {stats ? (
              <>
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
                      <Stat label="Purged tombstones hard-deleted (90d)" value={backupReport.tombstonesPurged ?? '—'} />
                    </ul>
                    {backupReport.failures.length > 0 && <p className="warn">{backupReport.failures.join(' | ')}</p>}
                  </div>
                )}

                {backups.users.map(u => (
                  <div key={u.userId} className="admin-health">
                    <p className="sync-line">
                      <strong>{u.email ?? `${u.userId.slice(0, 8)}… (no account)`}</strong>
                      <span>
                        {u.files.length} snapshot{u.files.length === 1 ? '' : 's'} · {bytes(u.bytes)}
                      </span>
                    </p>
                    <ul className="cal-sources admin-users">
                      {u.files.map(f => (
                        <li key={f.path} className="cal-source">
                          <span className="cal-source-name">
                            {f.date}
                            <small> · {bytes(f.size)}</small>
                          </span>
                          <button className="btn subtle" disabled={busy} onClick={() => download(f.path)}>
                            {pending === f.path ? 'Signing…' : 'Download'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {downloadUrl && (
                  <div className="copy-row">
                    <input readOnly value={downloadUrl} onFocus={e => e.currentTarget.select()} />
                    <a className="btn" href={downloadUrl} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </div>
                )}
                <p className="field-hint">Download links are signed for five minutes; the bucket itself stays private.</p>
              </>
            ) : (
              <p className="field-hint">Listing snapshots…</p>
            )}
          </section>

          <section className="settings-section g-integrations">
            <h3>Integration health</h3>
            <p className="field-hint">
              Host environment setup. Values never leave the server — only configured / missing names are shown here. The Test buttons make a real call and report the
              latency or the error.
            </p>

            {status ? (
              <>
                <HealthCard title="Web push (VAPID)" piece={status.vapid}>
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

                <HealthCard title="iOS push (APNs)" piece={status.apns}>
                  {!status.apns.configured && (
                    <p className="field-hint">
                      Set <code>APNS_KEY_ID</code>, <code>APNS_TEAM_ID</code>, <code>APNS_PRIVATE_KEY</code> (the .p8 contents), and <code>APNS_BUNDLE_ID</code>. Use{' '}
                      <code>APNS_ENV=sandbox</code> for Xcode / Simulator builds. Needs an Apple Developer Program membership.
                    </p>
                  )}
                  <p className="field-hint">Test it with “Send test push” above — one send covers both channels.</p>
                </HealthCard>

                <HealthCard title="Google Calendar" piece={status.google}>
                  {!status.google.configured && (
                    <p className="field-hint">
                      Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on Netlify. The OAuth client's redirect URI must be{' '}
                      <code>{status.google.redirectUri}</code>.
                    </p>
                  )}
                </HealthCard>

                <HealthCard title="Outlook / Microsoft 365" piece={status.microsoft}>
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
                    <code>NVIDIA_API_KEY</code> (free from build.nvidia.com) or <code>ANTHROPIC_API_KEY</code> in the host environment (Netlify). No key is ever stored in the
                    browser.
                    {status.ai.configured && (
                      <>
                        {' '}
                        Currently using {status.ai.nvidia ? 'NVIDIA' : null}
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
                    <TestLine
                      ok={aiTest.ok}
                      detail={[aiTest.provider, `${aiTest.latencyMs} ms`, aiTest.sample && `replied “${aiTest.sample}”`].filter(Boolean).join(' · ')}
                      error={aiTest.error}
                    />
                  )}
                </HealthCard>

                <HealthCard title="GitHub" piece={status.github}>
                  <p className="field-hint">
                    GitHub link cards use <code>GITHUB_TOKEN</code> the same way. Scope <code>read:project</code> for Projects; repo/issues write for status write-back.
                  </p>
                </HealthCard>

                <HealthCard title="Digest email (Resend)" piece={status.resend}>
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
          </section>

          <section className="settings-section g-domains">
            <h3>Associated domains (Universal Links)</h3>
            <p className="field-hint">
              Blocked on an Apple Developer Program team ID. Until then, digests and invites open in Safari; the app still receives{' '}
              <code>drafter://</code> deep links and OAuth returns.
            </p>
            <div className="admin-health">
              <p className="sync-line">
                <strong>apple-app-site-association</strong>
                <span className="warn">Not shipped</span>
              </p>
              <p className="field-hint">
                When the team ID exists, publish <code>public/.well-known/apple-app-site-association</code> for the site host and add the Associated Domains entitlement{' '}
                <code>applinks:drafterz.netlify.app</code> (plus the custom domain if any) in{' '}
                <code>ios/App/App/App.entitlements</code>. Path patterns should cover <code>/</code>, <code>/?view=*</code>, <code>/?task=*</code>, and{' '}
                <code>/?saw=*</code>.
              </p>
            </div>
            <div className="admin-health">
              <p className="sync-line">
                <strong>Password Autofill / Keychain</strong>
                <span className="warn">Needs webcredentials</span>
              </p>
              <p className="field-hint">
                Same AASA file can list <code>webcredentials:drafterz.netlify.app</code> so iCloud Keychain offers the saved password on the sign-in screen. Face ID lock is Settings → Reminders → Lock this iPhone (no paid Apple team required).
              </p>
            </div>
          </section>

          {error && <p className="warn">{error}</p>}
        </div>

        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
