import { FormEvent, useState } from 'react'
import { getSupabase, isSupabaseConfigured } from '../supabase'
import { siteOrigin } from '../api'

interface Props {
  onBack?: () => void
  /**
   * An assistant is waiting on an /oauth/authorize request (src/oauthRequest.ts):
   * the card says signing in is what connects it, and Back reads Cancel, since
   * it drops the request.
   */
  connecting?: boolean
}

export function Login({ onBack, connecting = false }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** "Check your inbox" after a reset was asked for; cleared by typing again. */
  const [sent, setSent] = useState('')
  // a copy with no backend (local mode) has no account to sign in to, so there is nothing to connect
  const noAccount = connecting && !isSupabaseConfigured()

  /**
   * Ask Supabase to email a recovery link. The reply is deliberately the same
   * whether or not that address has an account: this form is public, and a
   * different answer for a real one turns it into a way to find out who has
   * one. The link comes back to this site and App shows SetPassword.
   */
  async function forgot() {
    const sb = getSupabase()
    const to = email.trim()
    if (!sb || !to) return setError('Type your email address first, then tap this again.')
    setBusy(true)
    setError('')
    // the hosted site, never the shell's own origin: a capacitor:// URL is
    // not somewhere Supabase can send anyone back to
    await sb.auth.resetPasswordForEmail(to, { redirectTo: siteOrigin() })
    setBusy(false)
    setSent(`If ${to} has an account, a link to set a new password is on its way. It can take a minute.`)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const sb = getSupabase()
    if (!sb) return
    setBusy(true)
    setError('')
    const { error: err } = await sb.auth.signInWithPassword({ email: email.trim(), password })
    if (err) setError(err.message)
    setBusy(false)
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="brand-mark">✈</span>
          <span>Drafter</span>
        </div>
        <p className="login-sub">{noAccount ? 'Connect Claude to Drafter' : connecting ? 'Sign in to connect Claude to Drafter' : 'Sign in to your planner'}</p>
        {noAccount ? (
          <p className="warn">Connecting Claude needs a Drafter account, and this copy of Drafter has none: it keeps everything on this device.</p>
        ) : (
          <>
            <label className="field">
              <span>Email</span>
              <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => {
                setEmail(e.target.value)
                setSent('')
              }}
              autoFocus
              required
            />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </label>
            {error && <p className="warn">{error}</p>}
            {sent && <p className="sync-ok">{sent}</p>}
            <button className="btn primary login-btn" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" className="btn subtle login-forgot" disabled={busy} onClick={forgot}>
              Forgot your password?
            </button>
            <p className="field-hint">
              There is no public sign-up: the person who runs this planner creates the accounts.
            </p>
          </>
        )}
        {onBack && (
          <button type="button" className="btn subtle" onClick={onBack}>
            {connecting ? 'Cancel' : '← Back'}
          </button>
        )}
      </form>
    </div>
  )
}
