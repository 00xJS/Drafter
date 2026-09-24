import { GARMENT_TYPE_META, OCCASION_META, type Garment } from '../../types'
import { fitsOccasion, wornShort, type DayOccasion, type WearIndex } from '../../wardrobe'
import { Icon } from '../Icon'
import { heldBadge, type Slot } from './composer'
import { FavouriteMark, GarmentInset, GarmentPhoto, hasBack, mainSide, otherSide, TYPE_ICON, type Side } from './GarmentPhoto'

/** How a slot is spoken of: "a top", "outerwear", "shoes". */
export const SLOT_WORDS: Record<Slot, string> = { top: 'a top', bottom: 'a bottom', onepiece: 'a one-piece', outerwear: 'outerwear', shoes: 'shoes' }

/**
 * One slot of the look card holding a piece: its photo, square and whole; its
 * name; its type and when it was last worn; a badge when it is for the other
 * occasion, or held for the day (retired, or in Trash). A tap opens the picker
 * for the slot, and ✕ takes the piece off. A piece with a back photo shows its
 * other side in the photo's corner: a button beside the row, not in it, that
 * swaps the two for this visit and saves nothing.
 */
export function FilledSlot({
  garment: g,
  ix,
  occasion,
  flipped,
  onFlip,
  onOpen,
  onClear,
}: {
  garment: Garment
  ix: WearIndex
  occasion: DayOccasion
  /** Shown by its other side for this visit. */
  flipped: boolean
  onFlip(): void
  onOpen(): void
  onClear(): void
}) {
  const held = heldBadge(g)
  const shown: Side = flipped && hasBack(g) ? otherSide(mainSide(g)) : mainSide(g)
  const label = GARMENT_TYPE_META[g.type].label
  // a piece for the other occasion says so; one for any time, or for this, needs no word
  const other = !held && !!g.occasion && !fitsOccasion(g, occasion)
  return (
    <li className="look-slot">
      <button type="button" className="look-slot-main" aria-label={`${label}: ${g.name}${held ? ` (${held})` : ''}. Choose another`} onClick={onOpen}>
        <GarmentPhoto key={shown} garment={g} side={shown} className="look-thumb flippable" />
        <span className="look-slot-text">
          <span className="look-slot-name">
            {g.favourite && <FavouriteMark inline />}
            {g.name}
          </span>
          <span className="look-slot-meta">
            <span className="look-slot-when">
              {label} · {wornShort(ix, g.id)}
            </span>
            {held && <span className="badge look-held">{held}</span>}
            {other && g.occasion && <span className={`badge occasion-badge ${g.occasion}`}>{OCCASION_META[g.occasion].label}</span>}
          </span>
        </span>
      </button>
      {hasBack(g) && <GarmentInset garment={g} side={otherSide(shown)} className="look-flip" onFlip={onFlip} />}
      <button type="button" className="look-slot-clear" aria-label={`Take off ${g.name}`} title="Take it off" onClick={onClear}>
        <span aria-hidden="true">✕</span>
      </button>
    </li>
  )
}

/**
 * A slot with nothing in it: a slim dashed row that asks for one ("Add a top")
 * and opens the picker. A coat the forecast suggests is offered by name, with
 * why under it, and a tap puts it on. An optional slot (outerwear, shoes) has
 * its ✕ too, which closes it.
 */
export function EmptySlot({ slot, suggest, why, onOpen, onClose }: { slot: Slot; suggest?: Garment; why?: string; onOpen(): void; onClose?(): void }) {
  return (
    <li className="look-slot look-slot-empty">
      <button type="button" className="look-slot-add" onClick={onOpen}>
        <span className="look-slot-icon" aria-hidden="true">
          <Icon name={TYPE_ICON[slot]} strokeWidth={1.5} />
        </span>
        <span className="look-slot-text">
          <span className="look-slot-ask">{suggest ? `Add ${suggest.name}` : `Add ${SLOT_WORDS[slot]}`}</span>
          {why && <span className="look-slot-why">{why}</span>}
        </span>
      </button>
      {onClose && (
        <button type="button" className="look-slot-clear" aria-label={suggest ? `Not ${suggest.name} today` : `Close ${GARMENT_TYPE_META[slot].label.toLowerCase()}`} title={suggest ? 'Not today' : 'Close'} onClick={onClose}>
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </li>
  )
}
