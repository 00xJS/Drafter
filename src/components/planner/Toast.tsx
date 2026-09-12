import type { Toast as ToastState } from './routes'

interface Props {
  toast: ToastState | null
  setToast: (toast: ToastState | null) => void
}

/** The bar at the foot of the screen: what just happened, with its Undo or its confirm step. */
export function Toast({ toast, setToast }: Props) {
  if (!toast) return null
  return (
    <div className="toast" role="status">
      <span>{toast.msg}</span>
      {toast.undo && (
        <button
          className="toast-undo"
          onClick={() => {
            toast.undo?.()
            setToast(null)
          }}
        >
          Undo
        </button>
      )}
      {toast.action && (
        <button
          className="toast-undo"
          onClick={() => {
            toast.action?.run()
            setToast(null)
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
        ✕
      </button>
    </div>
  )
}
