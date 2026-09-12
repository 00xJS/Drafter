import { useEffect, useRef, useState } from 'react'
import { conflictMessage, type Store } from '../../store'
import type { Toast } from './routes'

/** The shell's one toast, and the one way to show it: a message, and an Undo or a confirm step. */
export function useToast({ store }: { store: Store }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = (msg: string, undo?: () => void, action?: Toast['action']) => {
    window.clearTimeout(toastTimer.current)
    setToast({ msg, undo, action })
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 15000 : 6000)
  }
  // A local edit that lost a field to another device's edit of the same field:
  // say so, and offer it back — Keep mine writes this device's values again.
  useEffect(
    () => store.onConflict(found => showToast(conflictMessage(found), undefined, { label: 'Keep mine', run: () => store.keepMine(found) })),
    // the engine's own functions, stable for the life of the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  return { toast, setToast, showToast }
}
