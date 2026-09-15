import { useRef, useState, type MutableRefObject } from 'react'
import { countOf } from '../../people'
import { garmentTags } from '../../schema'
import { OCCASION_META, SEASONS, SEASON_META, type Garment, type Occasion } from '../../types'
import { priceOf, withDetails, wornWith, type WearIndex } from '../../wardrobe'
import { GarmentPhoto } from './GarmentPhoto'

/** "Wear it for"'s three answers, in the order it says them: work, personal, or both — which is marking neither. */
const WEAR_FOR: { value?: Occasion; label: string }[] = [
  { value: 'work', label: OCCASION_META.work.label },
  { value: 'personal', label: OCCASION_META.personal.label },
  { label: 'Both' },
]

/** "Wear it for: Work · Personal · Both", Both by default: the piece sheet's, and Add clothing's. */
export function OccasionChoice({ value, onChange }: { value?: Occasion; onChange(o: Occasion | undefined): void }) {
  return (
    <span className="segmented garment-occasion" role="radiogroup" aria-label="Wear it for">
      {WEAR_FOR.map(o => (
        <button key={o.label} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'seg on' : 'seg'} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  )
}

interface Props {
  garment: Garment
  ix: WearIndex
  byId: ReadonlyMap<string, Garment>
  /** An edit of the piece as it is by then: the sheet's own, so each is stamped newer than the last. */
  onEdit(change: (cur: Garment) => Garment): void
  /** Another piece's sheet: one this is worn with. */
  onOpenPiece(id: string): void
  /**
   * Set here to what keeps the fields still typed in: the sheet runs it as it
   * closes or moves on, as it keeps its name and notes — a tap on ✕ need not
   * blur a field first. A piece deleted from the sheet keeps nothing typed.
   */
  keep: MutableRefObject<() => void>
}

const priceText = (g: Garment) => String(priceOf(g) ?? '')
const tagsText = (g: Garment) => (g.tags ?? []).join(', ')

/**
 * A price as typed: whole units ("£40", "39.99" is 40), null for an empty
 * field or for nothing at all ("0" is no price, as priceOf reads one),
 * undefined for anything that is not a price.
 */
export function readPrice(text: string): number | null | undefined {
  const bare = text.replace(/[,\s£$€]/g, '')
  if (bare === '') return null
  const n = Number(bare)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n) > 0 ? Math.round(n) : null
}

/**
 * A piece's own details on its sheet: what it cost, what it is worn for, the
 * seasons it is for, its tags, and the pieces it is worn with most. The two
 * typed fields save on Enter or blur, or through `keep` when the sheet
 * closes; an occasion or a season saves as it is tapped.
 */
export function PieceDetails({ garment: g, ix, byId, onEdit, onOpenPiece, keep }: Props) {
  const [price, setPrice] = useState(() => priceText(g))
  const [tags, setTags] = useState(() => tagsText(g))
  // what each field was last filled with: one left as it was writes nothing,
  // whatever a sync has done to the piece since
  const filled = useRef({ price, tags })
  const company = wornWith(g.id, ix, byId)

  const commitPrice = () => {
    if (price === filled.current.price) return
    const n = readPrice(price)
    // not a price at all: the field goes back to what is kept
    const text = n === undefined ? priceText(g) : n === null ? '' : String(n)
    setPrice(text)
    filled.current.price = text
    if (n !== undefined && (n ?? undefined) !== g.price) onEdit(cur => withDetails(cur, { price: n }))
  }
  const commitTags = () => {
    if (tags === filled.current.tags) return
    const next = garmentTags(tags.split(',')) ?? []
    const text = next.join(', ')
    setTags(text)
    filled.current.tags = text
    if (next.join(',') !== (g.tags ?? []).join(',')) onEdit(cur => withDetails(cur, { tags: next }))
  }
  keep.current = () => {
    commitPrice()
    commitTags()
  }
  const onEnter = (commit: () => void) => (e: { key: string; preventDefault(): void }) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    commit()
  }

  return (
    <>
      <label className="field">
        <span>
          Price <small className="muted">(what it cost)</small>
        </span>
        <input value={price} inputMode="decimal" maxLength={12} placeholder="0" onChange={e => setPrice(e.target.value)} onBlur={commitPrice} onKeyDown={onEnter(commitPrice)} />
      </label>
      <div className="field">
        <span>Wear it for</span>
        <OccasionChoice value={g.occasion} onChange={o => o !== g.occasion && onEdit(cur => withDetails(cur, { occasion: o ?? null }))} />
      </div>
      <div className="field">
        <span>
          Seasons <small className="muted">(none is any season)</small>
        </span>
        <div className="garment-seasons" role="group" aria-label="Seasons">
          {SEASONS.map(s => {
            const on = !!g.seasons?.includes(s)
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                className={on ? 'toggle on' : 'toggle'}
                onClick={() =>
                  onEdit(cur => {
                    const had = cur.seasons ?? []
                    return withDetails(cur, { seasons: had.includes(s) ? had.filter(x => x !== s) : [...had, s] })
                  })
                }
              >
                {SEASON_META[s].label}
              </button>
            )
          })}
        </div>
      </div>
      <label className="field">
        <span>
          Tags <small className="muted">(comma-separated)</small>
        </span>
        <input value={tags} placeholder="work, gym" onChange={e => setTags(e.target.value)} onBlur={commitTags} onKeyDown={onEnter(commitTags)} />
      </label>
      {company.length > 0 && (
        <div className="field">
          <span>Worn with</span>
          <ul className="garment-with">
            {company.map(c => (
              <li key={c.garment.id}>
                <button type="button" className="garment-with-piece" onClick={() => onOpenPiece(c.garment.id)}>
                  <GarmentPhoto garment={c.garment} className="thumb-28" />
                  <span className="garment-with-name">{c.garment.name}</span>
                  <small className="muted">{countOf(c.days, 'day')}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
