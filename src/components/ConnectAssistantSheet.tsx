import { useEffect, useState } from 'react'
import type { AgentScope } from '../agents'
import { approveRequest, clearAuthorizeRequest, describeRequest, returnsTo, safeRedirect } from '../oauthRequest'
import type { AuthorizeAnswer, AuthorizeDescription } from '../oauthRequest'
import { Modal, ModalHead } from './Modal'

interface Props {
  /** The captured /oauth/authorize query (pendingAuthorizeRequest()). */
  params: URLSearchParams
  /** Who is signed in, so the user knows which planner they are sharing. */
  email: string
  /** The sheet is finished without leaving the app: denied in place, an unusable request dismissed. */
  onDone(): void
  /** "Not you?" — sign out, keeping the request so the right account can answer it. */
  onSignOut(): void
  /** Tests and previews: the server calls and the navigation (defaults: src/oauthRequest.ts, location.assign). */
  describe?: (params: URLSearchParams) => Promise<AuthorizeDescription>
  approve?: (params: URLSearchParams, decision: 'allow' | 'deny', scopes: readonly AgentScope[]) => Promise<AuthorizeAnswer>
  navigate?: (url: string) => void
}

type Phase =
  | { step: 'checking' }
  | { step: 'ask'; desc: Extract<AuthorizeDescription, { ok: true }> }
  | { step: 'leaving'; clientName: string }
  | { step: 'refused'; message: string }

/**
 * "Connect Claude?" — the consent step of Drafter's OAuth server, shown over
 * the planner while a captured authorization request waits. It says who is
 * asking, where the answer will go (the host in bold; loopback reads "an app
 * on this computer"), who is signed in, and what the connection may do.
 * A request the server does not accept shows an error card and never
 * redirects anywhere.
 */
export function ConnectAssistantSheet({ params, email, onDone, onSignOut, describe = describeRequest, approve = approveRequest, navigate = url => window.location.assign(url) }: Props) {
  const [phase, setPhase] = useState<Phase>({ step: 'checking' })
  const [canWrite, setCanWrite] = useState(true)
  const [journal, setJournal] = useState(false)
  const [busy, setBusy] = useState(false)

  // keyed on the query, not the object: a parent that rebuilds params on each render must not re-ask
  const query = params.toString()
  useEffect(() => {
    let live = true
    describe(new URLSearchParams(query)).then(desc => {
      if (!live) return
      if (desc.ok) setPhase({ step: 'ask', desc })
      else setPhase({ step: 'refused', message: desc.message })
    })
    return () => {
      live = false
    }
  }, [query, describe])

  const answer = async (decision: 'allow' | 'deny') => {
    if (phase.step !== 'ask') return
    setBusy(true)
    const scopes: AgentScope[] = ['read', ...(canWrite ? (['write'] as const) : []), ...(journal ? (['journal'] as const) : [])]
    const res = await approve(params, decision, decision === 'allow' ? scopes : [])
    setBusy(false)
    if (!res.ok) {
      setPhase({ step: 'refused', message: res.message })
      return
    }
    clearAuthorizeRequest()
    if (!safeRedirect(res.redirect)) {
      setPhase({ step: 'refused', message: 'Drafter was given an address it will not send you to. Nothing was shared.' })
      return
    }
    setPhase({ step: 'leaving', clientName: phase.desc.clientName })
    navigate(res.redirect)
  }

  const dismiss = () => {
    clearAuthorizeRequest()
    onDone()
  }

  return (
    // A consent screen never closes on a stray tap on the backdrop. Escape and ✕
    // do what Close does — drop the request, nothing shared, no redirect; Deny
    // stays the explicit answer. Once it is sending you back, nothing closes it.
    <Modal onClose={phase.step === 'leaving' ? () => {} : dismiss} className="modal narrow" closeOnBackdrop={false}>
        <ModalHead
          title={
            phase.step === 'ask'
              ? `Connect ${phase.desc.clientName}?`
              : phase.step === 'refused'
                ? 'This connection request can’t be used'
                : phase.step === 'leaving'
                  ? `Returning to ${phase.clientName}…`
                  : 'Connect an assistant'
          }
        />

        <div className="modal-body">
          {phase.step === 'checking' && <p className="field-hint">Checking the request…</p>}

          {phase.step === 'refused' && (
            <>
              <p className="warn">{phase.message}</p>
              <p className="field-hint">Nothing was shared. Start connecting again from the assistant if you meant to.</p>
            </>
          )}

          {phase.step === 'leaving' && <p className="field-hint">Your planner is connected. You can revoke it any time in Settings → Assistants.</p>}

          {phase.step === 'ask' && (
            <>
              <p>
                {phase.desc.clientName} wants to use your Drafter planner. It will return to <strong>{returnsTo(phase.desc)}</strong>.
              </p>
              <p className="sync-line">
                <small>Signed in as {email || 'you'}.</small>
                <button type="button" className="btn subtle" onClick={onSignOut} disabled={busy}>
                  Sign out
                </button>
              </p>
              <div className="field">
                <span>It may</span>
                <label className="cal-source mirror-row">
                  <input type="checkbox" checked disabled />
                  <span className="cal-source-name">See your planner</span>
                </label>
                <label className="cal-source mirror-row">
                  <input type="checkbox" checked={canWrite} onChange={e => setCanWrite(e.target.checked)} disabled={busy} />
                  <span className="cal-source-name">Add and change things</span>
                </label>
                <label className="cal-source mirror-row">
                  <input type="checkbox" checked={journal} onChange={e => setJournal(e.target.checked)} disabled={busy} />
                  <span className="cal-source-name">Read and write your journal</span>
                </label>
              </div>
              {phase.desc.existingConnectionId && (
                <p className="field-hint">You already have a connection from {phase.desc.clientName}. This adds another — revoke the old one in Settings → Assistants.</p>
              )}
              <p className="field-hint">You can change your mind any time: Settings → Assistants lists every connection, with Revoke.</p>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <span className="spacer" />
          {phase.step === 'ask' ? (
            <>
              <button type="button" className="btn" onClick={() => answer('deny')} disabled={busy}>
                Deny
              </button>
              <button type="button" className="btn primary" onClick={() => answer('allow')} disabled={busy}>
                {busy ? 'Connecting…' : 'Allow'}
              </button>
            </>
          ) : phase.step === 'refused' || phase.step === 'checking' ? (
            <button type="button" className="btn" onClick={dismiss}>
              Close
            </button>
          ) : null}
        </footer>
    </Modal>
  )
}
