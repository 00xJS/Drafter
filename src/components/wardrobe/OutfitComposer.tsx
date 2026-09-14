import { useEffect, useMemo, useRef, useState } from 'react'
import { shiftDayKey } from '../../journal'
import { shortDay } from '../../kitchen'
import { GARMENT_TYPE_META, type Garment, type GarmentType, type Outfit, type Wear } from '../../types'
import { byRest, looksOn, type WearIndex } from '../../wardrobe'
import { ConfirmButton } from '../ConfirmButton'
import { chosenIn, heldBadge, heldPieces, load, OPTIONAL, rowsOf, shownIn, start, type Optional, type Selection, type Slot } from './composer'
import { GarmentPhoto } from './GarmentPhoto'
import { SavedOutfits } from './SavedOutfits'
import { SnapRow } from './SnapRow'

/** Which of the optional rows are open: this device's preference, like the journal's stats. */
const ROWS_KEY = 'drafter:wardrobe-rows'
const NONE: Garment[] = []

function storedRows(): Optional[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ROWS_KEY) ?? '[]')
    return Array.isArray(saved) ? OPTIONAL.filter(s => saved.includes(s)) : []
  } catch {
    return []
  }
}

interface Props {
  garments: Garment[]
  /** Pieces in Trash: a day whose look still holds one shows it in its row. */
  inTrash?: Garment[]
  outfits: Outfit[]
  wears: Wear[]
  byId: ReadonlyMap<string, Garment>
  ix: WearIndex
  /** The day being dressed: today, or a day before it. */
  day: string
  todayKey: string
  onDay(day: string): void
  /**
   * Log the pieces on the day: its latest look takes them, or with `another` a
   * new look does. `shown` is every piece in the rows, so whatever else that
   * look holds stays.
   */
  onLog(day: string, pieces: string[], opts: { shown: ReadonlySet<string>; another?: boolean }): void
  onRemoveLook(day: string): void
  onSaveOutfit(pieces: string[]): void
  /** The piece sheet, to add one of a type. */
  onAdd(type: GarmentType): void
  /** The piece sheet, on one piece. */
  onOpenPiece(id: string): void
  onWearOutfit(o: Outfit): void
  onRenameOutfit(o: Outfit, name: string): void
  onDeleteOutfit(o: Outfit): void
  /** A saved outfit asked for from outside (the palette's search): put in the rows once, then handed back as used. */
  pending?: readonly string[] | null
  onPendingUsed?(): void
}

/**
 * Outfit: dress a day by swiping. A Tops row and a Bottoms row (or
 * One-pieces), Outerwear and Shoes when you open them, and Accessories as
 * chips; then Wearing this, or Save outfit, in a bar that stays in reach above
 * the tab bar. The rows lead with what has rested longest, in an order frozen
 * for the visit, and your saved outfits sit underneath. A day's look is shown
 * as it is: a retired piece in it, or one in Trash, joins its row for the
 * visit, badged, so Update look never writes over what you cannot see.
 */
export function OutfitComposer(props: Props) {
  const { garments, inTrash = NONE, outfits, wears, byId, ix, day, todayKey, onDay, onLog, onRemoveLook, onSaveOutfit, onAdd, onOpenPiece, pending, onPendingUsed } = props
  const [frozen] = useState(() => byRest(garments, ix).map(g => g.id))
  const dayLooks = looksOn(wears, day)
  const latest = dayLooks[dayLooks.length - 1]
  const held = useMemo(() => heldPieces(latest, garments, inTrash), [latest, garments, inTrash])
  const rows = useMemo(() => rowsOf(garments, frozen, held), [garments, frozen, held])
  const shown = useMemo(() => shownIn(rows), [rows])
  const [sel, setSel] = useState<Selection>(() => {
    const first = start(rows, latest, byId)
    return pending ? load(first, pending, rows, byId) : first
  })
  const [openRows, setOpenRows] = useState<Optional[]>(storedRows)

  // a day with a look brings its pieces into the rows; a day without one keeps
  // what is chosen, so a look put together here can be logged for yesterday
  const shownDay = useRef(day)
  useEffect(() => {
    if (shownDay.current === day) return
    shownDay.current = day
    setSel(s => (latest ? load(s, latest.garmentIds, rows, byId) : { ...s, note: undefined }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day])

  // a saved outfit asked for from outside goes in the rows once — after the
  // day's own look, so it is what shows — and is handed back as used, so
  // coming back to Outfit later does not put it there again
  useEffect(() => {
    if (!pending) return
    setSel(s => load(s, pending, rows, byId))
    onPendingUsed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  const { slots: chosen, accessories, both, onepieceMode, open, pieces, dressed } = chosenIn(sel, rows, openRows)
  const rowOpen = (s: Optional) => open.includes(s)

  const pick = (slot: Slot, id: string | null) => setSel(s => ({ ...s, note: undefined, picked: { ...s.picked, [slot]: id } }))
  const toggleAccessory = (id: string) =>
    setSel(s => ({
      ...s,
      note: undefined,
      picked: { ...s.picked, accessories: s.picked.accessories.includes(id) ? s.picked.accessories.filter(x => x !== id) : [...s.picked.accessories, id] },
    }))
  const showRow = (s: Optional, on: boolean) => {
    const next = on ? [...openRows.filter(x => x !== s), s] : openRows.filter(x => x !== s)
    setOpenRows(next)
    if (!on) pick(s, null)
    try {
      localStorage.setItem(ROWS_KEY, JSON.stringify(next))
    } catch {
      /* a preference, not data */
    }
  }
  const loadOutfit = (o: Outfit) => setSel(s => load(s, o.garmentIds, rows, byId))

  const yesterday = shiftDayKey(todayKey, -1)
  const dayName = `${day === todayKey ? 'Today · ' : day === yesterday ? 'Yesterday · ' : ''}${shortDay(day, todayKey)}`
  const logged = dayLooks.length > 0
  const primary = logged ? 'Update look' : day === todayKey ? 'Wearing this' : `Log for ${shortDay(day, todayKey)}`

  const row = (slot: Slot, optional?: Optional) => {
    const meta = GARMENT_TYPE_META[slot]
    return (
      <SnapRow
        key={slot}
        label={meta.plural}
        pieces={rows[slot]}
        ix={ix}
        selected={chosen[slot]}
        onSelect={id => pick(slot, id)}
        none={!!optional}
        small={!!optional}
        onHide={optional ? () => showRow(optional, false) : undefined}
        onInfo={onOpenPiece}
        onAdd={() => onAdd(slot)}
        addLabel={`+ Add ${meta.label.toLowerCase()}`}
        emptyLabel={`No ${meta.plural.toLowerCase()} yet · Add one`}
      />
    )
  }

  return (
    <div className="composer">
      <div className="wardrobe-day">
        <button type="button" className="btn subtle wardrobe-step" aria-label="The day before" onClick={() => onDay(shiftDayKey(day, -1))}>
          ‹
        </button>
        <span className="wardrobe-day-pick">
          <span className="wardrobe-day-name" aria-hidden="true">
            {dayName}
          </span>
          <input
            type="date"
            max={todayKey}
            value={day}
            aria-label={`Day: ${dayName}`}
            onChange={e => {
              const v = e.target.value
              // a look is for a day that has come: a future day is refused
              if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= todayKey) onDay(v)
            }}
            onClick={e => {
              try {
                e.currentTarget.showPicker()
              } catch {
                /* the browser opens its own, or has none to show */
              }
            }}
          />
        </span>
        <button type="button" className="btn subtle wardrobe-step" aria-label="The day after" disabled={day >= todayKey} onClick={() => onDay(shiftDayKey(day, 1))}>
          ›
        </button>
        {logged && (
          <span className="wardrobe-day-state">
            <span className="badge wardrobe-logged">Logged</span>
            <ConfirmButton className="btn subtle danger wardrobe-remove" confirmLabel="Remove?" ariaLabel="Remove look" onConfirm={() => onRemoveLook(day)}>
              Remove<span className="wardrobe-remove-more"> look</span>
            </ConfirmButton>
          </span>
        )}
      </div>

      {onepieceMode ? (
        row('onepiece')
      ) : (
        <>
          {row('top')}
          {row('bottom')}
        </>
      )}
      {OPTIONAL.filter(rowOpen).map(s => row(s, s))}
      {/* the rows' own options sit under them: at 375pt both rows and the bar
          need every point there is above the tab bar */}
      {(both || OPTIONAL.some(s => !rowOpen(s))) && (
        <div className="wardrobe-more">
          {both && (
            <span className="segmented wardrobe-mode" role="radiogroup" aria-label="Separates or a one-piece">
              <button type="button" role="radio" aria-checked={!onepieceMode} className={onepieceMode ? 'seg' : 'seg on'} onClick={() => setSel(s => ({ ...s, onepiece: false }))}>
                Separates
              </button>
              <button type="button" role="radio" aria-checked={onepieceMode} className={onepieceMode ? 'seg on' : 'seg'} onClick={() => setSel(s => ({ ...s, onepiece: true }))}>
                One-piece
              </button>
            </span>
          )}
          {OPTIONAL.filter(s => !rowOpen(s)).map(s => (
            <button key={s} type="button" className="toggle" onClick={() => showRow(s, true)}>
              + {GARMENT_TYPE_META[s].label}
            </button>
          ))}
        </div>
      )}
      {rows.accessory.length > 0 && (
        <div className="wardrobe-acc">
          <span className="snap-label">Accessories</span>
          <div className="wardrobe-acc-chips" role="group" aria-label="Accessories">
            {rows.accessory.map(g => {
              const on = accessories.includes(g.id)
              const badge = heldBadge(g)
              return (
                <button key={g.id} type="button" aria-pressed={on} className={on ? 'toggle on acc-chip' : 'toggle acc-chip'} onClick={() => toggleAccessory(g.id)}>
                  <GarmentPhoto garment={g} className="acc-thumb" />
                  {g.name}
                  {badge && <span className="acc-held">{badge}</span>}
                </button>
              )
            })}
            <button type="button" className="toggle acc-chip acc-add" onClick={() => onAdd('accessory')}>
              + Add accessory
            </button>
          </div>
        </div>
      )}
      {sel.note && <p className="wardrobe-note">{sel.note}</p>}

      <div className="wardrobe-actions">
        <button type="button" className="btn" disabled={!dressed} onClick={() => onSaveOutfit(pieces)}>
          Save outfit
        </button>
        <span className="spacer" />
        {logged && (
          // "+ Look" on a phone, where the three share one row
          <button type="button" className="btn" aria-label="Another look" disabled={!dressed} onClick={() => onLog(day, pieces, { shown, another: true })}>
            + <span className="wardrobe-another-long">Another look</span>
            <span className="wardrobe-another-short">Look</span>
          </button>
        )}
        <button type="button" className="btn primary" disabled={!dressed} onClick={() => onLog(day, pieces, { shown })}>
          {primary}
        </button>
      </div>

      <SavedOutfits outfits={outfits} byId={byId} ix={ix} onLoad={loadOutfit} onWear={props.onWearOutfit} onRename={props.onRenameOutfit} onDelete={props.onDeleteOutfit} />
    </div>
  )
}
