/**
 * A notes page button's words, three ways: the tooltip NoteTips shows at once
 * on hover or keyboard focus (data-tip), the name a screen reader reads
 * (aria-label), and the browser's own slower title. A letter or a symbol on a
 * button does not say what it does; these words do, the same for everyone.
 */
export function tipAttrs(words: string) {
  return { 'data-tip': words, 'aria-label': words, title: words }
}

/** Where a button sits in the window, as getBoundingClientRect gives it. */
export type TipBox = Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>

/**
 * Whether a tip stays up through a scroll. One raised under the mouse goes,
 * since the pointer is no longer on its button. One raised by keyboard focus
 * stays, moved with its button, while any of the button is in the window:
 * tabbing to a button off screen scrolls it into view, and that scroll must
 * not take away the tip the same focus raised.
 */
export function keepsTipOnScroll(mouse: boolean, at: TipBox, width: number, height: number): boolean {
  return !mouse && at.bottom > 0 && at.top < height && at.right > 0 && at.left < width
}
