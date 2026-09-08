import { useEffect, useState } from 'react'
import { AdminStatus, AdminUser, adminAction } from '../admin'
import { ConfirmButton } from './ConfirmButton'

const GROUPS = [
  { key: 'users', label: 'Users' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'domains', label: 'Domains' },
] as const
type Group = (typeof GROUPS)[number]['key']

interface Props {
  onClose(): void
}

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

export function Admin({ onClose }: Props) {
  const [group, setGroup] = useState<Group>('users')
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [status, setStatus] = useState<AdminStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [createEmail, setCreateEmail] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [resetEmail, setResetEmail] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [linkOut, setLinkOut] = useState('')
  const [copied, setCopied] = useState(false)

  const refreshUsers = () => adminAction<{ users: AdminUser[] }>('listUsers').then(r => setUsers(r.users))
  const refreshStatus = () => adminAction<AdminStatus>('status').then(setStatus)

  useEffect(() => {
    setError('')
    Promise.all([refreshUsers(), refreshStatus()]).catch(e => setError((e as Error).message))
  }, [])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

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
            {users ? (
              <ul className="cal-sources admin-users">
                {users.map(u => (
                  <li key={u.id} className="cal-source">
                    <span className="cal-source-name">
                      {u.email || u.id}
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
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">Loading users…</p>
            )}
          </section>

          <section className="settings-section g-integrations">
            <h3>Integration health</h3>
            <p className="field-hint">Host environment setup. Values never leave the server — only configured / missing names are shown here.</p>

            {status ? (
              <>
                <HealthCard title="Web push (VAPID)" piece={status.vapid}>
                  {!status.vapid.configured && (
                    <p className="field-hint">
                      Set <code>VAPID_PUBLIC_KEY</code> and <code>VAPID_PRIVATE_KEY</code> on Netlify (run <code>npx web-push generate-vapid-keys</code> for the pair). Optional{' '}
                      <code>VAPID_SUBJECT</code> (mailto: or https:).
                    </p>
                  )}
                </HealthCard>

                <HealthCard title="iOS push (APNs)" piece={status.apns}>
                  {!status.apns.configured && (
                    <p className="field-hint">
                      Set <code>APNS_KEY_ID</code>, <code>APNS_TEAM_ID</code>, <code>APNS_PRIVATE_KEY</code> (the .p8 contents), and <code>APNS_BUNDLE_ID</code>. Use{' '}
                      <code>APNS_ENV=sandbox</code> for Xcode / Simulator builds. Needs an Apple Developer Program membership.
                    </p>
                  )}
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
                    The ✨ features (break a task into steps, suggest tags, platform variants, post analysis) run through the site's server-side proxy — configure{' '}
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
                Same AASA file can list <code>webcredentials:drafterz.netlify.app</code> so iCloud Keychain offers the saved password on the sign-in screen. No Face ID gate until you opt in.
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
