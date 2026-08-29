import { FormEvent, useState } from 'react'
import { getSupabase } from '../supabase'

export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
        <p className="login-sub">Sign in to your planner</p>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required />
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
        <button className="btn primary login-btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="field-hint">
          Accounts are created in the Supabase dashboard (Authentication → Users) — there is no public sign-up.
        </p>
      </form>
    </div>
  )
}
