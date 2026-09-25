import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
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

/**
 * How long after a field in the sheet lets go of focus a press on the
 * backdrop is still that field's. On an iPhone the tap that puts a date wheel
 * or the keyboard away lands on the backdrop a moment after the field has
 * already blurred.
 */
export const FIELD_SETTLE_MS = 400

/** `onClose` is the sheet's way out as ✕ and Cancel take it: through "Discard changes?" when it has unsaved changes. */
const ModalContext = createContext<{ titleId: string; onClose(): void } | null>(null)

interface ModalProps {
  /** What closing does, once it is decided. Escape, the backdrop, ModalHead's ✕ and Cancel and the swipe down all come here, through `dirty`. */
  onClose(): void
  /**
   * Unsaved changes: every way out — the backdrop, Escape, ✕, Cancel and the
   * swipe down — asks "Discard changes?" once, in the app, and closes only
   * on Discard.
   */
  dirty?: boolean
  /** A question that must be answered (the discard prompt): announced as an alert dialog. */
  alert?: boolean
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
 *   field that ends there does not) — unless a field in the sheet is up: then
 *   that press puts the keyboard or the picker away and the sheet stays, and
 *   so does it for a moment after a field lets go (FIELD_SETTLE_MS);
 * - with `dirty`, every way out asks "Discard changes?" first (DiscardPrompt).
 * No haptics, no animation and no scroll lock of its own.
 */
export function Modal({
  onClose,
  dirty = false,
  alert = false,
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
  const [asking, setAsking] = useState(false)
  /** When a field in the panel last let go of focus (Date.now()). */
  const fieldLeft = useRef(-Infinity)
  /** Every way out comes here: straight out, or through the question when there is something to lose. */
  const requestClose = () => {
    if (dirty) setAsking(true)
    else onClose()
  }
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
  const close = useRef(requestClose)
  useLayoutEffect(() => {
    close.current = requestClose
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
        if (e.target !== e.currentTarget) return
        // a field in the sheet is up — the keyboard, a date wheel: a tap above
        // the sheet puts it away, as it does everywhere else on the phone, and
        // is not a request to throw the sheet away
        const active = document.activeElement
        if (active instanceof HTMLElement && panel.current?.contains(active) && active.matches(FIELD)) {
          active.blur()
          return
        }
        // …nor is the tap that has just done so, a moment after the field let go
        if (Date.now() - fieldLeft.current < FIELD_SETTLE_MS) return
        if (closeOnBackdrop) requestClose()
      }}
    >
      <div
        ref={panel}
        className={className}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={label ? undefined : (labelledBy ?? titleId)}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onBlur={e => {
          if (e.target instanceof Element && e.target.matches(FIELD)) fieldLeft.current = Date.now()
        }}
      >
        <ModalContext.Provider value={{ titleId, onClose: requestClose }}>{children}</ModalContext.Provider>
      </div>
      {asking && (
        <DiscardPrompt
          onKeep={() => setAsking(false)}
          onDiscard={() => {
            setAsking(false)
            onClose()
          }}
        />
      )}
    </div>
  )
}

/**
 * The one "Discard changes?": Keep editing, or Discard. In the app rather
 * than the browser's confirm, which on an iPhone is a system alert naming
 * the page's address. Drawn over the page itself (a portal), so it sits above
 * the sheet that asks; Escape and a tap beside it are Keep editing.
 */
export function DiscardPrompt({ onKeep, onDiscard }: { onKeep(): void; onDiscard(): void }) {
  const id = useId()
  // a server render has no page to put it over
  if (typeof document === 'undefined') return null
  return createPortal(
    <Modal onClose={onKeep} alert className="modal narrow discard-prompt" backdropClassName="modal-backdrop discard-backdrop" labelledBy={id}>
      <div className="discard-body">
        <h2 id={id}>Discard changes?</h2>
        <div className="discard-actions">
          <button type="button" className="btn" onClick={onKeep}>
            Keep editing
          </button>
          <button type="button" className="btn danger" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  )
}

/**
 * "Discard changes?" for a step that is not a close: More options on a bill
 * that cannot be saved as it stands. `ask(then)` puts the question up and
 * runs `then` on Discard; `prompt` is where it is drawn, anywhere in the sheet.
 */
export function useDiscardPrompt(): { ask(then: () => void): void; prompt: ReactNode } {
  const [then, setThen] = useState<(() => void) | null>(null)
  const prompt = then ? (
    <DiscardPrompt
      onKeep={() => setThen(null)}
      onDiscard={() => {
        setThen(null)
        then()
      }}
    />
  ) : null
  // a function in state is called as an updater: wrapped, it is kept as the value
  return { ask: next => setThen(() => next), prompt }
}

/**
 * Whether what a sheet holds has changed since it opened: `now`, the fields
 * as they stand, against what they were on its first render. For `dirty`.
 */
export function useChanged(now: unknown): boolean {
  const [opened] = useState(() => JSON.stringify(now))
  return JSON.stringify(now) !== opened
}

/** A Cancel in a sheet's own footer: out the way ✕ goes, asking first when the sheet has unsaved changes. */
export function ModalCancel({ children = 'Cancel', className = 'btn' }: { children?: ReactNode; className?: string }) {
  const modal = useContext(ModalContext)
  return (
    <button type="button" className={className} onClick={modal?.onClose}>
      {children}
    </button>
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
  return useCallback((e: ReactPointerEvent<HTMLElement>) => dragSheet(e, () => close.current?.()), [])
}

/** What dragSheet reads off the press on the title bar: the pointer, and the bar it landed on. */
type SheetPress = Pick<ReactPointerEvent<HTMLElement>, 'button' | 'pointerType' | 'pointerId' | 'clientY' | 'timeStamp' | 'target' | 'currentTarget'>

/**
 * Follow one drag that began on a sheet's title bar, from the press to the
 * finger lifting; `close` is asked to close it when the drag says so.
 */
export function dragSheet(e: SheetPress, close: () => void): void {
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

  // back where it was. Reduce Motion (01-base.css blanket-disables
  // animation, not inline transitions) gets it there at once.
  const springBack = () => {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    panel.style.transition = still ? 'none' : 'transform 0.24s cubic-bezier(0.32, 0.72, 0, 1)'
    panel.style.transform = ''
  }
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
      close()
      // A close can be turned down — "Discard changes?" answered Keep
      // editing — and the sheet stayed pushed down where the finger let go.
      // Still here a frame later means it was kept, so it goes back up.
      requestAnimationFrame(() => {
        if (panel.isConnected) springBack()
      })
      return
    }
    springBack()
  }
  head.addEventListener('pointermove', move)
  head.addEventListener('pointerup', end)
  head.addEventListener('pointercancel', end)
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
