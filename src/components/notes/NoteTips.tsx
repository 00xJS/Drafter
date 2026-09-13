import { useCallback, useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Room kept between a tip and the window's edge, and between a tip and its button. */
const EDGE = 8
const GAP = 6

/** True when focus came from the keyboard; a click focuses a button too, in some browsers. */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

/**
 * A notes page's tooltips. Every button there says what it does in data-tip
 * (tipAttrs gives the same words to its aria-label and title). The browser's
 * own title waits a second or more and never shows on keyboard focus, so this
 * shows those words at once under a mouse, or on focus from the keyboard:
 * above the button (below it when the window has no room above), kept inside
 * the window, and drawn at the top of the page, so neither a toolbar that
 * scrolls sideways nor the page edge can cut it off. A key press, a click or a
 * scroll puts it away, so it is never over what is being typed; a finger never
 * raises one.
 */
export function NoteTips({ root }: { root: RefObject<HTMLElement> }) {
  const [tip, setTip] = useState<{ text: string; at: DOMRect } | null>(null)

  useEffect(() => {
    const el = root.current
    if (!el) return
    const tipped = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null)
    const show = (t: HTMLElement | null) => {
      if (t?.dataset.tip && el.contains(t)) setTip({ text: t.dataset.tip, at: t.getBoundingClientRect() })
    }
    const hide = () => setTip(null)
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') show(tipped(e))
    }
    const out = (e: PointerEvent) => {
      const t = tipped(e)
      // moving between a button's own parts (its icon, its text) is not leaving it
      if (t && !(e.relatedTarget instanceof Node && t.contains(e.relatedTarget))) hide()
    }
    const focus = (e: FocusEvent) => {
      const t = tipped(e)
      if (t && keyboardFocus(t)) show(t)
    }
    el.addEventListener('pointerover', over)
    el.addEventListener('pointerout', out)
    el.addEventListener('pointerdown', hide)
    el.addEventListener('focusin', focus)
    el.addEventListener('focusout', hide)
    // capture, so a key typed anywhere puts it away before anything else sees the key
    window.addEventListener('keydown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      el.removeEventListener('pointerover', over)
      el.removeEventListener('pointerout', out)
      el.removeEventListener('pointerdown', hide)
      el.removeEventListener('focusin', focus)
      el.removeEventListener('focusout', hide)
      window.removeEventListener('keydown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [root])

  // placed as it mounts, before it is painted: centred on its button, then
  // nudged inside the window
  const place = useCallback(
    (box: HTMLSpanElement | null) => {
      if (!box || !tip) return
      const width = document.documentElement.clientWidth
      const left = Math.max(EDGE, Math.min(tip.at.left + tip.at.width / 2 - box.offsetWidth / 2, width - EDGE - box.offsetWidth))
      const above = tip.at.top - GAP - box.offsetHeight
      box.style.left = `${left}px`
      box.style.top = `${above >= EDGE ? above : tip.at.bottom + GAP}px`
    },
    [tip],
  )

  if (!tip) return null
  // the button's aria-label already says these words, so a screen reader skips the copy
  return createPortal(
    <span ref={place} className="notes-tip" aria-hidden="true">
      {tip.text}
    </span>,
    document.body,
  )
}
