import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { startSignOut, unsentLine, uploadThenSignOut, withMedia, type SignOutSteps, type UnsentAsk } from '../signout'
import { Modal, ModalHead } from './Modal'

/** What is under way: the count at the first tap, an upload being tried, or the sign-out itself. */
export type SignOutBusy = 'checking' | 'uploading' | 'signing-out'

interface SheetProps extends UnsentAsk {
  busy: SignOutBusy | null
  onUpload(): void
  onSignOut(): void
  onCancel(): void
}

/**
 * "n photos haven’t uploaded yet": the question a sign-out asks while a photo
 * is still waiting (src/signout.ts). Drawn from its props alone, so a server
 * render shows every state. Escape, the backdrop and ✕ are Cancel, and
 * nothing closes it while something is under way.
 */
export function UnsentPhotosSheet({ count, tried, busy, onUpload, onSignOut, onCancel }: SheetProps) {
  const waiting = busy !== null
  return (
    <Modal onClose={waiting ? () => {} : onCancel} className="modal narrow" closeOnBackdrop={!waiting}>
      <ModalHead title="Sign out?" />
      <div className="modal-body">
        <p>{unsentLine(count)}</p>
        {tried && (
          <p className="warn" role="alert">
            {count === 1 ? 'It' : 'They'} couldn’t be uploaded just now. Check the connection, then try again.
          </p>
        )}
      </div>
      <footer className="modal-foot unsent-foot">
        <button type="button" className="btn danger" disabled={waiting} onClick={onSignOut}>
          {busy === 'signing-out' ? 'Signing out…' : 'Sign out anyway'}
        </button>
        <button type="button" className="btn" disabled={waiting} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={waiting} onClick={onUpload}>
          {busy === 'uploading' ? 'Uploading…' : 'Try uploading now'}
        </button>
      </footer>
    </Modal>
  )
}

/**
 * A sign-out button's handler and the question it may raise. `start` signs
 * out at once when every photo is up; otherwise the question opens, over the
 * page itself (a portal), so it sits above whatever sheet the button is in.
 * `signOut` is the whole of it: the session, this device's copy, the reload.
 */
export function useSignOut(signOut: () => Promise<void>): { start(): void; busy: boolean; question: ReactNode } {
  const [ask, setAsk] = useState<UnsentAsk | null>(null)
  const [busy, setBusy] = useState<SignOutBusy | null>(null)
  const run = (phase: SignOutBusy, step: (steps: SignOutSteps) => Promise<UnsentAsk | null>) => {
    if (busy) return
    setBusy(phase)
    step(withMedia(signOut))
      .then(setAsk, () => {})
      .finally(() => setBusy(null))
  }
  const question =
    ask && typeof document !== 'undefined'
      ? createPortal(
          <UnsentPhotosSheet
            {...ask}
            busy={busy}
            onUpload={() => run('uploading', uploadThenSignOut)}
            onSignOut={() =>
              run('signing-out', async steps => {
                await steps.signOut()
                return null
              })
            }
            onCancel={() => setAsk(null)}
          />,
          document.body,
        )
      : null
  return { start: () => run('checking', startSignOut), busy: busy !== null, question }
}
