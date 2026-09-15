/**
 * What a Stats counts while its list's find box or chip narrows it, and the
 * way back. With something left it is one line under the chips, heading the
 * figures — "Stats for 3 of 12 places · Restaurant · matching “sushi”" — and
 * with nothing, the empty state saying so, in the same place. Either way Show
 * all, a real button, clears the find box and the chip together.
 */
export function Narrowed({ words, empty = false, onShowAll }: { words: string; empty?: boolean; onShowAll(): void }) {
  const showAll = (button: HTMLElement) => {
    // With nothing narrowing, this line goes, and the button with it. A
    // keyboard on it goes on to the chip that is on now, All, rather than
    // back to the top of the page; a tap left no focus here, so it moves
    // nothing.
    const held = typeof document !== 'undefined' && document.activeElement === button
    const view = button.closest('p')?.parentElement
    onShowAll()
    if (held && view) window.setTimeout(() => view.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true }), 0)
  }
  return (
    <p className={empty ? 'empty' : 'stats-narrowed'}>
      <span>{words}</span>{' '}
      <button type="button" className="btn subtle" onClick={e => showAll(e.currentTarget)}>
        Show all
      </button>
    </p>
  )
}
