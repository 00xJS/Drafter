import { FormEvent, useState } from 'react'
import { getSupabase } from '../supabase'

// Where a "reset your password" email lands.
//
// Supabase's recovery link signs the browser in with a session that is good
// for exactly one thing: setting a new password. supabase-js reads it out of
// the URL on load and fires PASSWORD_RECOVERY, and App puts this over
// everything else — because that session IS a signed-in session, and without
// this screen the link would drop someone straight into the planner with the
// password they had forgotten still on the account.

/** Supabase's own floor. Saying so here beats a server error after the tap. */
const MIN_PASSWORD = 8

export function SetPassword({ email, onDone }: { email?: string; onDone(): void }) {
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next.length < MIN_PASSWORD) return setError(`A password needs at least ${MIN_PASSWORD} characters.`)
    if (next !== again) return setError('Those two do not match.')
    const sb = getSupabase()
    if (!sb) return setError('This copy of Drafter has no account to change.')
    setBusy(true)
    setError('')
    const { error: err } = await sb.auth.updateUser({ password: next })
    setBusy(false)
    if (err) return setError(err.message)
    // the history entry still carries the recovery token in its fragment
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    onDone()
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="brand-mark">✈</span>
          <span>Drafter</span>
        </div>
        <p className="login-sub">Choose a new password{email ? ` for ${email}` : ''}</p>
        <label className="field">
          <span>New password</span>
          <input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} autoFocus required />
        </label>
        <label className="field">
          <span>Again</span>
          <input type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} required />
        </label>
        {error && <p className="warn">{error}</p>}
        <button className="btn primary login-btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save and sign in'}
        </button>
        <p className="field-hint">This link works once. Setting a password here signs you in on this device.</p>
      </form>
    </div>
  )
}
