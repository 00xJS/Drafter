/**
 * A notes page button's words, three ways: the tooltip NoteTips shows at once
 * on hover or keyboard focus (data-tip), the name a screen reader reads
 * (aria-label), and the browser's own slower title. A letter or a symbol on a
 * button does not say what it does; these words do, the same for everyone.
 */
export function tipAttrs(words: string) {
  return { 'data-tip': words, 'aria-label': words, title: words }
}
