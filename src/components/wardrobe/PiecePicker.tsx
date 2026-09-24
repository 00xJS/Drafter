import { useState } from 'react'
import { GARMENT_TYPE_META, type Garment } from '../../types'
import { fitsOccasion, wornShort, type DayOccasion, type WearIndex } from '../../wardrobe'
import { Icon } from '../Icon'
import { Modal, ModalHead } from '../Modal'
import { Segmented } from '../stats/Segmented'
import { pickerGroups, pickerOrder, type PickerFilter } from './board'
import { heldBadge, type Slot } from './composer'
import { FavouriteMark, GarmentPhoto } from './GarmentPhoto'
import { SLOT_WORDS } from './LookSlot'

interface Props {
  slot: Slot
  /** Every piece the slot can hold: the day's held pieces first, then the live ones. */
  pieces: readonly Garment[]
  /** What the slot holds now: ticked. */
  current: string | null
  /** What the day is dressed for: its pieces, and those for any time, are the first filter. */
  occasion: DayOccasion
  ix: WearIndex
  /** A tile tapped: the slot takes it (null for None), and the sheet closes. */
  onPick(id: string | null): void
  /** The last tile: Add clothing, for this slot's type. */
  onAdd(): void
  /** The piece the slot holds, on its sheet. */
  onOpenPiece(id: string): void
  onClose(): void
}

/**
 * Choose a top (or a bottom, a one-piece, outerwear, shoes): a sheet of square
 * photo tiles, three across on a phone, None first and + Add last, the piece
 * the slot holds ticked. For work — or For days off — shows the pieces for the
 * day and those for any time; All adds the others under Other days; Favourites
 * keeps the starred ones; a search narrows any of them.
 *
 * The order is worked out once, as the sheet opens, and kept while it is open:
 * the pieces for the day first, then the others, each group longest rested
 * first and then by name. Nothing moves under a thumb, and where a piece sits
 * is always said. A tap chooses and closes; nothing is written until the
 * look's own button is pressed.
 */
export function PiecePicker({ slot, pieces, current, occasion, ix, onPick, onAdd, onOpenPiece, onClose }: Props) {
  const [order] = useState(() => pickerOrder(pieces, ix))
  // a slot holding a piece for the other occasion opens on All, so its tick is on screen
  const [filter, setFilter] = useState<PickerFilter>(() => {
    const held = pieces.find(g => g.id === current)
    return held && !heldBadge(held) && !fitsOccasion(held, occasion) ? 'all' : 'fit'
  })
  const [query, setQuery] = useState('')
  const { held, fit, other, hidden } = pickerGroups(pieces, order, occasion, filter, query)
  const plural = GARMENT_TYPE_META[slot].plural.toLowerCase()
  const forDay = occasion === 'work' ? 'For work' : 'For days off'
  const chosen = pieces.find(g => g.id === current)
  const filters: { key: PickerFilter; label: string }[] = [
    { key: 'fit', label: forDay },
    { key: 'all', label: 'All' },
    { key: 'favourites', label: 'Favourites' },
  ]

  const tile = (g: Garment) => {
    const on = g.id === current
    const badge = heldBadge(g)
    return (
      <li key={g.id}>
        <button type="button" className={on ? 'pick-tile on' : 'pick-tile'} aria-pressed={on} onClick={() => onPick(g.id)}>
          <span className="pick-photo">
            <GarmentPhoto garment={g} />
            {g.favourite && <FavouriteMark />}
            {on && (
              <span className="pick-tick" aria-hidden="true">
                <Icon name="check" size={14} strokeWidth={2.5} />
              </span>
            )}
          </span>
          <span className="pick-name">{g.name}</span>
          {badge ? <span className="badge look-held">{badge}</span> : <span className="pick-worn">{wornShort(ix, g.id)}</span>}
        </button>
      </li>
    )
  }

  const nothing = held.length + fit.length + other.length === 0
  return (
    <Modal onClose={onClose} className="modal narrow pick-sheet">
      <ModalHead title={`Choose ${SLOT_WORDS[slot]}`} />
      <div className="modal-body">
        <div className="pick-tools">
          <Segmented role="group" items={filters} value={filter} onChange={k => setFilter(k)} label={`Which ${plural}`} className="pick-filter" />
          <input type="search" className="pick-search" value={query} placeholder={`Search ${plural}`} aria-label={`Search ${plural}`} enterKeyHint="search" onChange={e => setQuery(e.target.value)} />
        </div>
        <ul className="pick-grid">
          <li>
            <button type="button" className={current === null ? 'pick-tile none on' : 'pick-tile none'} aria-pressed={current === null} onClick={() => onPick(null)}>
              <span className="pick-photo">
                <span className="pick-none-mark" aria-hidden="true" />
                {current === null && (
                  <span className="pick-tick" aria-hidden="true">
                    <Icon name="check" size={14} strokeWidth={2.5} />
                  </span>
                )}
              </span>
              <span className="pick-name">None</span>
            </button>
          </li>
          {held.map(tile)}
          {fit.map(tile)}
          {other.length > 0 && (
            <li className="pick-group">
              <h3>Other days</h3>
            </li>
          )}
          {other.map(tile)}
          <li>
            <button type="button" className="pick-tile add" onClick={onAdd}>
              <span className="pick-photo">
                <Icon name="plus" size={22} />
              </span>
              <span className="pick-name">Add {SLOT_WORDS[slot]}</span>
            </button>
          </li>
        </ul>
        {nothing && <p className="pick-empty">{query.trim() ? `No ${plural} match “${query.trim()}”.` : filter === 'favourites' ? `No favourite ${plural} yet: star one on its sheet.` : `No ${plural} for the day yet.`}</p>}
        {hidden > 0 && (
          <button type="button" className="btn subtle pick-more" onClick={() => setFilter('all')}>
            {hidden} more for {occasion === 'work' ? 'days off' : 'work'} · Show all
          </button>
        )}
      </div>
      {chosen && !chosen.deletedAt && (
        <footer className="modal-foot pick-foot">
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              onClose()
              onOpenPiece(chosen.id)
            }}
          >
            About {chosen.name}
          </button>
        </footer>
      )}
    </Modal>
  )
}
