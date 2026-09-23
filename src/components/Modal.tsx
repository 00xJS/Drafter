import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
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
  onKeyDown,
  closeOnBackdrop = true,
}: ModalProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement | null>(null)
  // whatever had focus when this first rendered — read now, before an
  // autoFocus field inside takes it at commit
  const [opener] = useState(() => {
    // a server or test render has no document, and nothing to hand focus back to
    if (typeof document === 'undefined') return null
    const a = document.activeElement
    return a instanceof HTMLElement ? a : null
  })
  // decided at the first mount: StrictMode's rehearsal remount must not re-decide it
  const back = useRef<HTMLElement | null | undefined>(undefined)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })

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
        ref={panel}
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

/** A press on one of these is that control's, not the sheet's. */
const HEAD_CONTROL = 'button, a, input, select, textarea, [contenteditable]:not([contenteditable="false"])'
/** How far down a sheet has to be dragged to be let go of. */
const DISMISS_PX = 88
/** ...or less than that, thrown fast enough (px per ms). */
const FLING = 0.5
const FLING_PX = 24

/**
 * Drag the sheet down to close it, from its title bar.
 *
 * The card sheet has drawn a grab handle since the proportions pass — the
 * pill at the top of every modal under `.native` — and nothing has ever read
 * a drag on it. A handle is the one piece of iOS furniture that means exactly
 * one thing, so drawing it and ignoring the gesture is the sheet telling the
 * truth about what it is and lying about what it does.
 *
 * Only on the phone, because only there is the handle drawn; only downward,
 * so a drag can never lift the sheet off the top of the screen; and never
 * from a control in the bar, or Cancel and ✕ would take a press and a tiny
 * wobble as a drag instead of a tap.
 */
function useSheetDrag(onClose?: () => void): (e: ReactPointerEvent<HTMLElement>) => void {
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  return useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (!document.documentElement.classList.contains('native')) return
    if (e.target instanceof Element && e.target.closest(HEAD_CONTROL)) return
    const head = e.currentTarget
    const panel = head.closest<HTMLElement>('[role="dialog"]')
    if (!panel) return
    const startY = e.clientY
    const startT = e.timeStamp
    let dy = 0
    let last = startY
    let lastT = startT
    head.setPointerCapture(e.pointerId)
    // the entrance animation owns `transform` until it is done; taking the
    // sheet over means taking that off, or the two write the same property
    panel.style.animation = 'none'
    panel.style.transition = 'none'
    panel.style.willChange = 'transform'

    const move = (ev: PointerEvent) => {
      dy = Math.max(0, ev.clientY - startY)
      // a sheet dragged UP goes nowhere, but it should still feel held
      panel.style.transform = `translateY(${dy}px)`
      if (ev.clientY !== last) {
        last = ev.clientY
        lastT = ev.timeStamp
      }
    }
    const end = (ev: PointerEvent) => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', end)
      head.removeEventListener('pointercancel', end)
      panel.style.willChange = ''
      const ms = Math.max(1, ev.timeStamp - lastT)
      const thrown = dy > FLING_PX && (ev.clientY - last) / ms > FLING
      if (dy > DISMISS_PX || thrown) {
        close.current?.()
        return
      }
      // back where it was. Reduce Motion (01-base.css blanket-disables
      // animation, not inline transitions) gets it there at once.
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches
      panel.style.transition = still ? 'none' : 'transform 0.24s cubic-bezier(0.32, 0.72, 0, 1)'
      panel.style.transform = ''
    }
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', end)
    head.addEventListener('pointercancel', end)
  }, [])
}

/**
 * The title bar every editor already had: the heading (which names the
 * dialog), then any actions (a Save), then ✕. `variant="compose"` is the
 * iOS write sheet: Cancel, the title, then Save — no ✕, and it cannot wrap
 * those three onto the scrolling body. The card sheet hangs its grab handle
 * off `.modal-head`, and reads a drag on it (useSheetDrag).
 */
export function ModalHead({
  title,
  children,
  variant = 'default',
}: {
  title: ReactNode
  children?: ReactNode
  variant?: 'default' | 'compose'
}) {
  const modal = useContext(ModalContext)
  const onPointerDown = useSheetDrag(modal?.onClose)
  if (variant === 'compose') {
    return (
      <header className="modal-head modal-head-compose" onPointerDown={onPointerDown}>
        <button type="button" className="btn subtle modal-head-cancel" onClick={modal?.onClose}>
          Cancel
        </button>
        <h2 id={modal?.titleId}>{title}</h2>
        {children}
      </header>
    )
  }
  return (
    <header className="modal-head" onPointerDown={onPointerDown}>
      <h2 id={modal?.titleId}>{title}</h2>
      {children}
      <button className="btn subtle" onClick={modal?.onClose} aria-label="Close">
        ✕
      </button>
    </header>
  )
}
