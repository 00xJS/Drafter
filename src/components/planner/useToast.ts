import { useEffect, useState, type SetStateAction } from 'react'
import { conflictMessage, retiredMessage, type Store } from '../../store'
import type { Toast } from './routes'

/**
 * The shell's one toast, held outside React: only the bar that draws it
 * (ToastHost) listens. It used to be the planner's own state, so a toast
 * coming up and going again 6 s later drew the whole planner twice over, and
 * every screen in it, for one line at the foot of the screen.
 */
export interface Toaster {
  /** The toast showing, or null. */
  current(): Toast | null
  subscribe(listener: () => void): () => void
  /** Say something: a message, and an Undo or a confirm step. It goes by itself after 6 s, or 15 s with a confirm step. */
  show(msg: string, undo?: () => void, action?: Toast['action']): void
  /** What the toast's own buttons do: replace it or clear it, as a state setter would. */
  set(next: SetStateAction<Toast | null>): void
}

export function createToaster(): Toaster {
  let current: Toast | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const set = (next: SetStateAction<Toast | null>) => {
    const value = typeof next === 'function' ? next(current) : next
    if (value === current) return
    current = value
    for (const listener of [...listeners]) listener()
  }
  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    show(msg, undo, action) {
      clearTimeout(timer)
      set({ msg, undo, action })
      timer = setTimeout(() => set(null), action ? 15000 : 6000)
    },
    set,
  }
}

/** The shell's one toast, and the one way to show it: a message, and an Undo or a confirm step. */
export function useToast({ store }: { store: Store }) {
  const [toaster] = useState(createToaster)
  // the engine's own functions, the same for the life of the page: each is subscribed to once
  const { onConflict, keepMine, onRetired, restore } = store.actions
  // A local edit that lost a field to another device's edit of the same field:
  // say so, and offer it back — Keep mine writes this device's values again.
  useEffect(() => onConflict(found => toaster.show(conflictMessage(found), undefined, { label: 'Keep mine', run: () => keepMine(found) })), [onConflict, keepMine, toaster])
  // A repeat ticked off on two devices came round twice, and the extra that went
  // to the Trash held something the one kept does not: say so, and offer it back.
  useEffect(() => onRetired(found => toaster.show(retiredMessage(found), undefined, { label: 'Restore', run: () => restore(found.map(r => r.id)) })), [onRetired, restore, toaster])

  return { toaster, showToast: toaster.show }
}
