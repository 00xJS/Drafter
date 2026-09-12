import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject, ReactNode, Ref } from 'react'
import { createModalStack, pickReturn, wrapFocus } from '../modalstack'

/** Every open dialog, topmost last. One per page, like the focus it looks after. */
const stack = createModalStack<HTMLDivElement, HTMLElement>()

/** What a Tab press can land on. Hidden ones (Admin's other groups) are dropped at the press. */
const TABBABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(', ')

function tabbables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    el => el.tabIndex >= 0 && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  )
}

/** Focusing one of these on the phone raises the keyboard. */
const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

const usable = (el: HTMLElement) => el.isConnected && el !== document.body

function onDocumentKey(e: KeyboardEvent) {
  // a key pressed inside a dialog that is not one of these — the lock screen —
  // belongs to that dialog
  const host = e.target instanceof Element ? e.target.closest('[aria-modal="true"]') : null
  if (host && !stack.owns(host)) return
  if (stack.key(e)) e.preventDefault()
}

const ModalContext = createContext<{ titleId: string; onClose(): void } | null>(null)

interface ModalProps {
  /** Escape, the backdrop and ModalHead's ✕ all call this. Pass the "discard changes?" version where there is one. */
  onClose(): void
  children: ReactNode
  /** the panel's class; `modal` is what the iOS card sheet is drawn from */
  className?: string
  /** the backdrop's class; PullToRefresh leaves a touch that starts on `modal-backdrop` alone */
  backdropClassName?: string
  /** the dialog's name, when no heading on screen says it */
  label?: string
  /** id of the heading that names the dialog, when it is not a ModalHead's */
  labelledBy?: string
  panelRef?: Ref<HTMLDivElement>
  /** the panel's own keys, e.g. Cmd+Enter to save. Escape and Tab are already handled. */
  onKeyDown?(e: ReactKeyboardEvent<HTMLDivElement>): void
  /** false: a press on the dimmed backdrop does nothing. Default true. */
  closeOnBackdrop?: boolean
}

/**
 * The one dialog. Same DOM and classes the editors always drew — a backdrop,
 * then a panel — so the iOS card sheet and PullToRefresh see no difference;
 * what it adds is behaviour:
 * - the panel is a named modal dialog (`role="dialog"`, `aria-modal`, named by
 *   its ModalHead heading unless `label`/`labelledBy` say otherwise);
 * - on open, focus moves to the panel, unless something inside already took it
 *   (an autoFocus field). Never to a field from here: on the phone that raises
 *   the keyboard;
 * - Escape closes the topmost dialog only, and never while an IME composes;
 * - Tab and Shift+Tab go round the visible controls instead of leaving;
 * - on close, focus goes back to what opened it, if that is still on the page;
 * - a press that starts on the backdrop itself closes it (a drag out of a
 *   field that ends there does not).
 * No haptics, no animation and no scroll lock of its own.
 */
export function Modal({
  onClose,
  children,
  className = 'modal',
  backdropClassName = 'modal-backdrop',
  label,
  labelledBy,
  panelRef,
  onKeyDown,
  closeOnBackdrop = true,
}: ModalProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement | null>(null)
  // whatever had focus when this first rendered — read now, before an
  // autoFocus field inside takes it at commit
  const [opener] = useState(() => {
    const a = document.activeElement
    return a instanceof HTMLElement ? a : null
  })
  // decided at the first mount: StrictMode's rehearsal remount must not re-decide it
  const back = useRef<HTMLElement | null | undefined>(undefined)
  const close = useRef(onClose)
  close.current = onClose

  const setPanel = useCallback(
    (node: HTMLDivElement | null) => {
      panel.current = node
      if (typeof panelRef === 'function') panelRef(node)
      else if (panelRef) (panelRef as MutableRefObject<HTMLDivElement | null>).current = node
    },
    [panelRef],
  )

  useEffect(() => {
    const el = panel.current
    if (!el) return
    const release = stack.push({
      panel: el,
      onEscape: () => close.current(),
      onTab: backwards => {
        const to = wrapFocus(tabbables(el), document.activeElement, backwards, el)
        if (!to) return false
        to.focus()
        return true
      },
    })
    document.addEventListener('keydown', onDocumentKey)
    if (back.current === undefined) back.current = pickReturn(opener, stack.handoff(), usable)
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    return () => {
      release()
      if (stack.size() === 0) document.removeEventListener('keydown', onDocumentKey)
      // StrictMode's rehearsal unmount leaves the panel in the page; only a
      // real close gives focus back
      if (el.isConnected) return
      const to = back.current ?? null
      stack.handOff(to)
      // only into a vacuum: a dialog this close opened may hold focus already
      const lost = !document.activeElement || document.activeElement === document.body
      const phone = document.documentElement.classList.contains('native')
      if (to && lost && usable(to) && !(phone && to.matches(FIELD))) to.focus({ preventScroll: true })
    }
  }, [opener])

  return (
    <div
      className={backdropClassName}
      onMouseDown={e => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={setPanel}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={label ? undefined : (labelledBy ?? titleId)}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <ModalContext.Provider value={{ titleId, onClose }}>{children}</ModalContext.Provider>
      </div>
    </div>
  )
}

/**
 * The title bar every editor already had: the heading (which names the
 * dialog), then any actions (a Save), then ✕. The iOS card sheet hangs its
 * grab handle off `.modal-head`.
 */
export function ModalHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const modal = useContext(ModalContext)
  return (
    <header className="modal-head">
      <h2 id={modal?.titleId}>{title}</h2>
      {children}
      <button className="btn subtle" onClick={modal?.onClose} aria-label="Close">
        ✕
      </button>
    </header>
  )
}
