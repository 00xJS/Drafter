import { createContext, useContext, type ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * The fold control, for the Home cards that other components draw.
 *
 * Today folds its own sections by hand — it holds the list and puts a <Fold>
 * in each header. The focus card, the wardrobe card, habits, routines and the
 * journal card are each somebody else's component, and threading four props
 * through every one of them to reach a chevron would be four prop lists made
 * worse for one button. So Today provides the list here instead and each card
 * asks for its own fold in two lines:
 *
 *     const fold = useFold('habits', 'Habits')
 *     <section className={'chart-card' + fold.className}>
 *       <header className="chart-head"><div>…</div>{fold.control}</header>
 *
 * Outside Home there is no provider and `useFold` gives back nothing to draw,
 * which is what makes the same card foldable on Today and plain everywhere
 * else it appears.
 */

export type Folds = {
  folded: string[]
  onFold(id: string): void
}

const FoldsContext = createContext<Folds | null>(null)

export function HomeFolds({ value, children }: { value: Folds; children: ReactNode }) {
  return <FoldsContext.Provider value={value}>{children}</FoldsContext.Provider>
}

/** The chevron a card's header ends with, and the class its section takes. */
export function Fold({ id, name, folded, onFold }: Folds & { id: string; name: string }) {
  const shut = folded.includes(id)
  return (
    <button
      type="button"
      className="btn subtle card-fold"
      aria-expanded={!shut}
      aria-label={`${shut ? 'Show' : 'Hide'} ${name}`}
      title={shut ? `Show ${name}` : `Hide ${name}`}
      onClick={() => onFold(id)}
    >
      <Icon name="chevron" size={16} />
    </button>
  )
}

/**
 * `className` is ' folded' while the card is shut — appended, so a card that
 * already builds its own class keeps it — and `control` is the chevron, or
 * null where nothing is folding (every screen but Home).
 */
export function useFold(id: string, name: string): { className: string; control: ReactNode } {
  const folds = useContext(FoldsContext)
  if (!folds) return { className: '', control: null }
  return {
    className: folds.folded.includes(id) ? ' folded' : '',
    control: <Fold id={id} name={name} folded={folds.folded} onFold={folds.onFold} />,
  }
}
