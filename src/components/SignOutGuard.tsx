import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { expiredLine, signOutAnyway, signOutFlow, startSignOut, unsentLine, uploadThenSignOut, withMedia, type SignOutBusy, type UnsentAsk } from '../signout'
import { Modal, ModalHead } from './Modal'

interface SheetProps extends UnsentAsk {
  busy: SignOutBusy | null
  /** The session has expired: nothing can upload, so Try uploading now is not offered. */
  expired?: boolean
  onUpload(): void
  onSignOut(): void
  onCancel(): void
}

/**
 * "n photos haven’t uploaded yet": the question a sign-out asks while a photo
 * is still waiting (src/signout.ts). Drawn from its props alone, so a server
 * render shows every state. Escape, the backdrop and ✕ are Cancel, which
 * still works while an upload is tried (the upload carries on behind it);
 * only the sign-out itself holds every answer.
 */
export function UnsentPhotosSheet({ count, tried, busy, expired = false, onUpload, onSignOut, onCancel }: SheetProps) {
  const leaving = busy === 'signing-out'
  return (
    <Modal onClose={leaving ? () => {} : onCancel} className="modal narrow" closeOnBackdrop={!leaving}>
      <ModalHead title="Sign out?" />
      <div className="modal-body">
        <p>{unsentLine(count)}</p>
        {expired && <p>{expiredLine(count)}</p>}
        {tried && !expired && (
          <p className="warn" role="alert">
            {count === 1 ? 'It' : 'They'} couldn’t be uploaded just now. Check the connection, then try again.
          </p>
        )}
      </div>
      <footer className="modal-foot unsent-foot">
        <button type="button" className="btn danger" disabled={busy !== null} onClick={onSignOut}>
          {leaving ? 'Signing out…' : 'Sign out anyway'}
        </button>
        {/* with nothing to try, Cancel is the answer that keeps them */}
        <button type="button" className={expired ? 'btn primary' : 'btn'} disabled={leaving} onClick={onCancel}>
          Cancel
        </button>
        {!expired && (
          <button type="button" className="btn primary" disabled={busy !== null} onClick={onUpload}>
            {busy === 'uploading' ? 'Uploading…' : 'Try uploading now'}
          </button>
        )}
      </footer>
    </Modal>
  )
}

/**
 * A sign-out button's handler and the question it may raise. `start` signs
 * out at once when every photo is up; otherwise the question opens, over the
 * page itself (a portal), so it sits above whatever sheet the button is in.
 * `signOut` is the whole of it: the session, this device's copy, the reload.
 * `sessionExpired`: nothing can upload, and the question says so rather than
 * offer to try.
 */
export function useSignOut(signOut: () => Promise<void>, sessionExpired = false): { start(): void; busy: boolean; question: ReactNode } {
  const [ask, setAsk] = useState<UnsentAsk | null>(null)
  const [busy, setBusy] = useState<SignOutBusy | null>(null)
  // made on first use and kept, as an upload spans renders; it signs out with the latest handler
  const latest = useRef(signOut)
  useLayoutEffect(() => {
    latest.current = signOut
  })
  const made = useRef<ReturnType<typeof signOutFlow> | null>(null)
  const flow = () => (made.current ??= signOutFlow(() => withMedia(latest.current), { ask: setAsk, busy: setBusy }))
  const question =
    ask && typeof document !== 'undefined'
      ? createPortal(
          <UnsentPhotosSheet
            {...ask}
            busy={busy}
            expired={sessionExpired}
            onUpload={() => void flow().run('uploading', uploadThenSignOut)}
            onSignOut={() => void flow().run('signing-out', signOutAnyway)}
            onCancel={() => flow().cancel()}
          />,
          document.body,
        )
      : null
  return { start: () => void flow().run('checking', startSignOut), busy: busy !== null, question }
}
