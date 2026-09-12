import { useEffect, useState } from 'react'
import { householdAction } from '../../household'
import { clearLocalData } from '../../idb'
import { disablePush } from '../../push'
import { getSupabase } from '../../supabase'
import { ConfirmButton } from '../ConfirmButton'
import type { SettingsCtx } from './context'
import { useAsyncAction } from './useAsyncAction'

/** Household: who shares this planner, invitations either way, and your name as they see it. */
export function Household({ store, household, supabaseOn }: SettingsCtx) {
  const [hhName, setHhName] = useState('')
  const [invite, setInvite] = useState('')
  const [displayName, setDisplayName] = useState(household.info?.me.displayName ?? '')
  const { busy: hhBusy, error: hhError, run } = useAsyncAction()
  const runHh = (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn()
      await household.refresh()
      store.retainMine(household.myId)
      // leave/remove/accept change which peer rows RLS returns — authoritative full exchange drops ghosts
      await store.fullResync()
    })

  if (!supabaseOn) return null
  return (
    <section className="settings-section g-household">
      <h3>Household</h3>
      <p className="field-hint">
        Share the planner with the people you live with: everyone in the household sees the same projects, tasks,
        notes and people, can assign tasks to each other, and keeps their own calendars, reminders and reviews.
      </p>
      <div className="check-add">
        <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name as others see it" />
        <button className="btn" disabled={hhBusy} onClick={() => runHh(() => householdAction('me', { displayName }))}>
          Save name
        </button>
      </div>
      {(household.info?.invites ?? []).length > 0 && (
        <ul className="cal-sources">
          {household.info!.invites!.map(inv => (
            <li key={inv.householdId} className="cal-source">
              <span className="cal-source-name">
                <strong>{inv.name}</strong> <small>invited you to share their planner</small>
              </span>
              <button className="btn primary" disabled={hhBusy} onClick={() => runHh(() => householdAction('accept', { householdId: inv.householdId }))}>
                Accept
              </button>
              <button className="btn subtle" disabled={hhBusy} onClick={() => runHh(() => householdAction('decline'))}>
                Decline
              </button>
            </li>
          ))}
        </ul>
      )}
      {household.info?.household ? (
        <>
          <p className="sync-line">
            <strong>{household.info.household.name}</strong>
            <small className="muted">{household.info.members.length} member{household.info.members.length === 1 ? '' : 's'}</small>
            <span className="spacer" />
            <ConfirmButton className="btn subtle danger" confirmLabel="Leave household?" onConfirm={() => runHh(() => householdAction('leave'))}>
              Leave
            </ConfirmButton>
          </p>
          <ul className="cal-sources">
            {household.info.members.map(m => (
              <li key={m.id} className="cal-source">
                <span className="assignee">{m.displayName.slice(0, 2).toUpperCase()}</span>
                <span className="cal-source-name">
                  {m.displayName} <small>· {m.email}{m.role === 'owner' ? ' · owner' : ''}{m.id === household.myId ? ' · you' : ''}</small>
                </span>
                {m.id !== household.myId && household.info?.members.find(x => x.id === household.myId)?.role === 'owner' && (
                  <ConfirmButton className="btn subtle danger" confirmLabel="Remove?" onConfirm={() => runHh(() => householdAction('remove', { userId: m.id }))}>
                    Remove
                  </ConfirmButton>
                )}
              </li>
            ))}
          </ul>
          <div className="check-add">
            <input value={invite} onChange={e => setInvite(e.target.value)} placeholder="Add a member by their account email" type="email" />
            <button className="btn" disabled={hhBusy || !invite.trim()} onClick={() => runHh(() => householdAction('invite', { email: invite })).then(() => setInvite(''))}>
              Add
            </button>
          </div>
          <p className="field-hint">
            They need an account first (the site owner creates accounts in Admin). They will see the invitation in
            their own Settings and must accept it — nothing is shared until they do.
          </p>
        </>
      ) : (
        <div className="check-add">
          <input value={hhName} onChange={e => setHhName(e.target.value)} placeholder="Household name, e.g. The Sucklings" />
          <button className="btn primary" disabled={hhBusy} onClick={() => runHh(() => householdAction('create', { name: hhName }))}>
            Create household
          </button>
        </div>
      )}
      {(hhError || household.error) && <p className="warn">{hhError || household.error}</p>}
    </section>
  )
}

/** Household → Account: who is signed in here, and signing out (which wipes this device's copy). */
export function Account({ supabaseOn, onClose }: SettingsCtx) {
  const [accountEmail, setAccountEmail] = useState('')
  useEffect(() => {
    getSupabase()
      ?.auth.getSession()
      .then(({ data }) => setAccountEmail(data.session?.user.email ?? ''))
  }, [])

  if (!supabaseOn) return null
  return (
    <section className="settings-section g-household">
      <h3>Account</h3>
      <p>{accountEmail ? `Signed in as ${accountEmail}.` : 'Signed in.'}</p>
      <button
        className="btn"
        onClick={async () => {
          // stop notifications and wipe the local copy BEFORE dropping the
          // session, while the token is still valid to deregister with
          await disablePush().catch(() => {})
          await getSupabase()?.auth.signOut()
          await clearLocalData()
          onClose()
          window.location.reload()
        }}
      >
        Sign out
      </button>
    </section>
  )
}
