import type { Dispatch, SetStateAction } from 'react'
import type { Toast as ToastState } from './routes'

interface Props {
  toast: ToastState | null
  setToast: Dispatch<SetStateAction<ToastState | null>>
}

/** The bar at the foot of the screen: what just happened, with its Undo or its confirm step. */
export function Toast({ toast, setToast }: Props) {
  if (!toast) return null
  const shown = toast
  // A button does its work, then closes the toast it sits on — unless that
  // work put up a toast of its own (Add's "Added to today's journal" with its
  // Undo, Saw them's "Logged a visit"). That one is newer; closing would wipe
  // it the moment it appeared. Identity, not the words, says which is which.
  const press = (work: () => void) => () => {
    work()
    setToast(current => (current === shown ? null : current))
  }
  return (
    <div className="toast" role="status">
      <span>{toast.msg}</span>
      {toast.undo && (
        <button className="toast-undo" onClick={press(() => shown.undo?.())}>
          Undo
        </button>
      )}
      {toast.action && (
        <button className="toast-undo" onClick={press(() => shown.action?.run())}>
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
        ✕
      </button>
    </div>
  )
}
