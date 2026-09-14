import { useEffect, useMemo, useRef, useState } from 'react'
import { shiftDayKey } from '../../journal'
import { shortDay } from '../../kitchen'
import { GARMENT_TYPES, GARMENT_TYPE_META, type Garment, type GarmentType, type Outfit, type Wear } from '../../types'
import { byRest, coreKey, looksOn, type WearIndex } from '../../wardrobe'
import { ConfirmButton } from '../ConfirmButton'
import { GarmentPhoto } from './GarmentPhoto'
import { SavedOutfits } from './SavedOutfits'
import { SnapRow } from './SnapRow'

/** The slots that hold one piece each; accessories hold any number. */
type Slot = Exclude<GarmentType, 'accessory'>
type Rows = Record<GarmentType, Garment[]>
interface Picked {
  top: string | null
  bottom: string | null
  onepiece: string | null
  outerwear: string | null
  shoes: string | null
  accessories: string[]
}
interface Selection {
  picked: Picked
  /** The One-piece side of the Separates / One-piece switch. */
  onepiece: boolean
  /** Said under the rows when an outfit with a deleted piece is put in them. */
  note?: string
}

/** The two rows you open when you want them. */
const OPTIONAL = ['outerwear', 'shoes'] as const
type Optional = (typeof OPTIONAL)[number]
/** Which of them are open: this device's preference, like the journal's stats. */
const ROWS_KEY = 'drafter:wardrobe-rows'

function storedRows(): Optional[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ROWS_KEY) ?? '[]')
    return Array.isArray(saved) ? OPTIONAL.filter(s => saved.includes(s)) : []
  } catch {
    return []
  }
}

/**
 * The rows, dealt in the order frozen when the composer mounted: a piece added
 * since goes on the end of its row, and one retired or deleted since drops
 * out. They never re-sort under a thumb during a visit.
 */
function rowsOf(garments: readonly Garment[], frozen: readonly string[]): Rows {
  const rows = Object.fromEntries(GARMENT_TYPES.map(t => [t, [] as Garment[]])) as Rows
  const live = new Map(garments.filter(g => !g.deletedAt && !g.archivedAt).map(g => [g.id, g]))
  for (const id of frozen) {
    const g = live.get(id)
    if (g) rows[g.type].push(g)
  }
  const dealt = new Set(frozen)
  for (const g of [...live.values()].filter(g => !dealt.has(g.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) rows[g.type].push(g)
  return rows
}

/**
 * A look or an outfit put in the rows. A slot it has a piece for takes it (the
 * first, when it has two); one it has none for keeps its card, except
 * outerwear and shoes, which go to None. A piece that is in no row (retired or
 * deleted) leaves its row where it was.
 */
function load(sel: Selection, ids: readonly string[], rows: Rows): Selection {
  const inRows = new Map(GARMENT_TYPES.flatMap(t => rows[t].map(g => [g.id, g] as const)))
  const picked: Picked = { ...sel.picked, outerwear: null, shoes: null, accessories: [] }
  const filled = new Set<GarmentType>()
  for (const id of ids) {
    const g = inRows.get(id)
    if (!g) continue
    if (g.type === 'accessory') picked.accessories.push(g.id)
    else if (!filled.has(g.type)) picked[g.type] = g.id
    filled.add(g.type)
  }
  const onepiece = filled.has('onepiece') ? true : filled.has('top') || filled.has('bottom') ? false : sel.onepiece
  return { picked, onepiece }
}

/** Where the rows start: on the day's latest look when it has one, otherwise on each row's first card. */
function start(rows: Rows, look: Wear | undefined): Selection {
  const first: Selection = {
    picked: { top: rows.top[0]?.id ?? null, bottom: rows.bottom[0]?.id ?? null, onepiece: rows.onepiece[0]?.id ?? null, outerwear: null, shoes: null, accessories: [] },
    onepiece: false,
  }
  return look ? load(first, look.garmentIds, rows) : first
}

interface Props {
  garments: Garment[]
  outfits: Outfit[]
  wears: Wear[]
  byId: ReadonlyMap<string, Garment>
  ix: WearIndex
  /** The day being dressed: today, or a day before it. */
  day: string
  todayKey: string
  onDay(day: string): void
  /** Log the pieces on the day: its latest look takes them, or with `another` a new look does. */
  onLog(day: string, pieces: string[], another?: boolean): void
  onRemoveLook(day: string): void
  onSaveOutfit(pieces: string[]): void
  /** The piece sheet, to add one of a type. */
  onAdd(type: GarmentType): void
  /** The piece sheet, on one piece. */
  onOpenPiece(id: string): void
  onWearOutfit(o: Outfit): void
  onRenameOutfit(o: Outfit, name: string): void
  onDeleteOutfit(o: Outfit): void
}

/**
 * Outfit: dress a day by swiping. A Tops row and a Bottoms row (or
 * One-pieces), Outerwear and Shoes when you open them, and Accessories as
 * chips; then Wearing this, or Save outfit, in a bar that stays in reach above
 * the tab bar. The rows lead with what has rested longest, in an order frozen
 * for the visit, and your saved outfits sit underneath.
 */
export function OutfitComposer(props: Props) {
  const { garments, outfits, wears, byId, ix, day, todayKey, onDay, onLog, onRemoveLook, onSaveOutfit, onAdd, onOpenPiece } = props
  const [frozen] = useState(() => byRest(garments, ix).map(g => g.id))
  const rows = useMemo(() => rowsOf(garments, frozen), [garments, frozen])
  const dayLooks = looksOn(wears, day)
  const latest = dayLooks[dayLooks.length - 1]
  const [sel, setSel] = useState<Selection>(() => start(rows, latest))
  const [openRows, setOpenRows] = useState<Optional[]>(storedRows)

  // a day with a look brings its pieces into the rows; a day without one keeps
  // what is chosen, so a look put together here can be logged for yesterday
  const shownDay = useRef(day)
  useEffect(() => {
    if (shownDay.current === day) return
    shownDay.current = day
    if (latest) setSel(s => load(s, latest.garmentIds, rows))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day])

  /** The chosen id when it is still in its row (a piece retired from its sheet mid-visit is not). */
  const member = (type: GarmentType, id: string | null) => (id && rows[type].some(g => g.id === id) ? id : null)
  const chosen: Record<Slot, string | null> = {
    top: member('top', sel.picked.top) ?? rows.top[0]?.id ?? null,
    bottom: member('bottom', sel.picked.bottom) ?? rows.bottom[0]?.id ?? null,
    onepiece: member('onepiece', sel.picked.onepiece) ?? rows.onepiece[0]?.id ?? null,
    outerwear: member('outerwear', sel.picked.outerwear),
    shoes: member('shoes', sel.picked.shoes),
  }
  const accessories = sel.picked.accessories.filter(id => member('accessory', id))
  const separates = rows.top.length > 0 || rows.bottom.length > 0
  const onepieces = rows.onepiece.length > 0
  const onepieceMode = onepieces && (!separates || sel.onepiece)
  const rowOpen = (s: Optional) => openRows.includes(s) || !!chosen[s]
  const pieces = [...(onepieceMode ? [chosen.onepiece] : [chosen.top, chosen.bottom]), ...OPTIONAL.map(s => (rowOpen(s) ? chosen[s] : null)), ...accessories].filter(
    (id): id is string => !!id,
  )
  const dressed = coreKey(pieces, byId) !== null

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
  const loadOutfit = (o: Outfit) => setSel(s => ({ ...load(s, o.garmentIds, rows), note: o.garmentIds.some(id => !byId.has(id)) ? 'A piece was deleted' : undefined }))

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
      {((separates && onepieces) || OPTIONAL.some(s => !rowOpen(s))) && (
        <div className="wardrobe-more">
          {separates && onepieces && (
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
              return (
                <button key={g.id} type="button" aria-pressed={on} className={on ? 'toggle on acc-chip' : 'toggle acc-chip'} onClick={() => toggleAccessory(g.id)}>
                  <GarmentPhoto garment={g} className="acc-thumb" />
                  {g.name}
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
          <button type="button" className="btn" disabled={!dressed} onClick={() => onLog(day, pieces, true)}>
            + Another look
          </button>
        )}
        <button type="button" className="btn primary" disabled={!dressed} onClick={() => onLog(day, pieces)}>
          {primary}
        </button>
      </div>

      <SavedOutfits outfits={outfits} byId={byId} ix={ix} onLoad={loadOutfit} onWear={props.onWearOutfit} onRename={props.onRenameOutfit} onDelete={props.onDeleteOutfit} />
    </div>
  )
}
