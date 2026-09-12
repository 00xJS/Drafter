/**
 * The open dialogs, as data. Modal.tsx owns the DOM side — the one document
 * keydown listener, moving focus in and giving it back — and asks this module
 * every question that has an answer, so the answers can be tested in node.
 */

/** The parts of a keydown the stack reads. A DOM KeyboardEvent is one. */
export interface KeyLike {
  key: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
  keyCode?: number
  defaultPrevented?: boolean
}

export interface ModalEntry<P = unknown> {
  /** the dialog's panel: how a key pressed inside somebody else's dialog is told apart */
  panel: P
  /** Escape: close, or ask first when there are unsaved changes */
  onEscape(): void
  /** Tab: move focus and return true, or return false to let the browser move it */
  onTab(backwards: boolean): boolean
}

/**
 * An input method owns Escape and Tab while it composes: Escape there cancels
 * the candidate word, and must not close the dialog underneath. Safari reports
 * the key that ends a composition with isComposing already false, but with the
 * 229 keyCode every IME keystroke carries.
 */
export function isComposing(e: KeyLike): boolean {
  return !!e.isComposing || e.keyCode === 229
}

/**
 * `P` is a dialog's panel, `T` whatever focus goes back to. The app keeps one
 * stack (in Modal.tsx); tests make their own.
 */
export function createModalStack<P = unknown, T = unknown>() {
  const entries: ModalEntry<P>[] = []
  let handoff: T | null = null
  return {
    /** Puts a dialog on top. Returns what takes it off again, wherever it sits by then. */
    push(entry: ModalEntry<P>): () => void {
      entries.push(entry)
      return () => {
        const i = entries.lastIndexOf(entry)
        if (i !== -1) entries.splice(i, 1)
      }
    },
    size: () => entries.length,
    owns: (panel: unknown) => entries.some(e => e.panel === panel),
    /**
     * Hands one keydown to the topmost dialog, and to no other. True when it
     * was used, so the caller can prevent the browser's own handling.
     */
    key(e: KeyLike): boolean {
      const top = entries[entries.length - 1]
      // something inside (a field, a menu) already dealt with it
      if (!top || e.defaultPrevented || isComposing(e)) return false
      if (e.key === 'Escape') {
        top.onEscape()
        return true
      }
      // Ctrl+Tab and Cmd+Tab switch tabs and apps; they are not ours
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) return top.onTab(!!e.shiftKey)
      return false
    },
    /**
     * Where a closing dialog sent focus back to. A dialog opened by that same
     * close — the day sheet's Edit opens the event editor — was opened from a
     * button that has just left the page, so on its own close it returns here
     * instead. Good until the current task ends: the next commit starts clean.
     */
    handOff(target: T | null): void {
      handoff = target
      queueMicrotask(() => {
        if (handoff === target) handoff = null
      })
    },
    handoff: (): T | null => handoff,
  }
}

/**
 * Where Tab goes when it would leave the dialog: past the last control to the
 * first, back from the first to the last. From anything that is not one of the
 * controls — the panel itself, or the page after the focused button was
 * removed — to the first (Shift: the last). With nothing to tab to, focus
 * stays on `panel`. null means the move stays inside by itself: leave it to
 * the browser.
 */
export function wrapFocus<T>(items: readonly T[], active: unknown, backwards: boolean, panel: T): T | null {
  if (items.length === 0) return panel
  const first = items[0]
  const last = items[items.length - 1]
  const i = items.indexOf(active as T)
  if (i === -1) return backwards ? last : first
  if (backwards && i === 0) return last
  if (!backwards && i === items.length - 1) return first
  return null
}

/**
 * What a dialog gives focus back to when it closes: whatever had focus when it
 * opened, if that is still usable; otherwise what the dialog that closed as it
 * opened handed off; otherwise nothing.
 */
export function pickReturn<T>(opener: T | null, handoff: T | null, usable: (el: T) => boolean): T | null {
  if (opener && usable(opener)) return opener
  if (handoff && usable(handoff)) return handoff
  return null
}
