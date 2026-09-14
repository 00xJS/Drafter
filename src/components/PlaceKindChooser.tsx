import { PLACE_CATEGORIES, PLACE_CATEGORY_META, PlaceCategory } from '../types'

interface Props {
  /** The kind picked so far: none until you pick one. */
  value?: PlaceCategory
  onChange(kind: PlaceCategory): void
  /** What the row asks, for a screen reader. */
  label?: string
}

/**
 * What kind of place somewhere new is: one compact row of the nine kinds, none
 * picked until you pick. Every path that saves a place from a name you typed or
 * an event's location asks with this row — a task's Where, Saw them, the meal
 * picker's Somewhere new and Who was there? — and keeps its Create or Save
 * disabled until you answer, so a place is never filed under a kind nobody chose.
 */
export function PlaceKindChooser({ value, onChange, label = 'Kind of place' }: Props) {
  return (
    <div className="place-kinds" role="radiogroup" aria-label={label}>
      {PLACE_CATEGORIES.map(c => (
        <button key={c} type="button" role="radio" aria-checked={value === c} className={value === c ? 'toggle on' : 'toggle'} onClick={() => onChange(c)}>
          <span aria-hidden="true">{PLACE_CATEGORY_META[c].emoji}</span> {PLACE_CATEGORY_META[c].label}
        </button>
      ))}
    </div>
  )
}
