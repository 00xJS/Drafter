import { useEffect, useMemo, useRef, useState } from 'react'
import { shiftDayKey } from '../../journal'
import { shortDay } from '../../kitchen'
import { GARMENT_TYPE_META, LOOK_NOTE_MAX, type Garment, type GarmentType, type Outfit, type Wear } from '../../types'
import {
  byRest,
  DAY_OCCASION_LABEL,
  dayOccasion,
  lastPlanDay,
  looksOn,
  otherOccasion,
  outerwearFor,
  seasonOf,
  weatherLine,
  weatherNeed,
  type DayOccasion,
  type WearIndex,
} from '../../wardrobe'
import type { Forecast } from '../../weather'
import { ConfirmButton } from '../ConfirmButton'
import { Icon } from '../Icon'
import { chosenIn, heldBadge, heldPieces, load, OPTIONAL, rowsOf, shownIn, start, surprise, type Optional, type Selection, type Slot } from './composer'
import { useCachedForecast } from './forecast'
import { FavouriteMark, GarmentPhoto } from './GarmentPhoto'
import { SavedOutfits } from './SavedOutfits'
import { SnapRow } from './SnapRow'

/** Which of the optional rows are open: this device's preference, like the journal's stats. */
const ROWS_KEY = 'drafter:wardrobe-rows'
const NONE: Garment[] = []
const NO_DAYS: ReadonlySet<string> = new Set()

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
  /** The day being dressed: today, a day before it, or a day ahead to plan. */
  day: string
  todayKey: string
  /** Your work days (calgrid.ts workDaysOf): a day among them is dressed for work, any other is a day off. */
  workDays?: ReadonlySet<string>
  onDay(day: string): void
  /**
   * Log the pieces on the day: its latest look takes them, or with `another` a
   * new look does; a day still to come is planned rather than logged. `shown`
   * is every piece in the rows, so whatever else that look holds stays.
   * `note` is the look's note, as the field under the rows says it.
   */
  onLog(day: string, pieces: string[], opts: { shown: ReadonlySet<string>; another?: boolean; note?: string }): void
  onRemoveLook(day: string): void
  onSaveOutfit(pieces: string[]): void
  /** The piece sheet, to add one of a type. */
  onAdd(type: GarmentType): void
  /** The piece sheet, on one piece. */
  onOpenPiece(id: string): void
  onWearOutfit(o: Outfit): void
  onRenameOutfit(o: Outfit, name: string): void
  onFavouriteOutfit(o: Outfit, on: boolean): void
  onDeleteOutfit(o: Outfit): void
  /** Today's forecast; by default the one the briefing cached (the tests hand one in). */
  forecast?: Forecast | null
  /** A saved outfit asked for from outside (the palette's search): put in the rows once, then handed back as used. */
  pending?: readonly string[] | null
  onPendingUsed?(): void
}

/**
 * Outfit: dress a day by swiping. A Tops row and a Bottoms row (or
 * One-pieces), Outerwear and Shoes when you open them, and Accessories as
 * chips; then Wearing this, or Save outfit, in a bar that stays in reach above
 * the tab bar. The rows lead with what has rested longest, in an order frozen
 * for the visit, Surprise me deals them a look, and your saved outfits sit
 * underneath. A day's look is shown as it is: a retired piece in it, or one in
 * Trash, joins its row for the visit, badged, so Update look never writes over
 * what you cannot see. A day still to come is planned: its look counts once it
 * is said to be worn. On today, a cold or wet forecast offers a coat.
 *
 * Beside the date, the day is a Work day (a work-day entry of yours is on the
 * calendar) or a Day off; a tap turns it the other way for this visit and
 * saves nothing. The pieces for it, or for both, lead each row, and those for
 * the other occasion follow, quieter; Surprise me and the coat keep to it.
 */
export function OutfitComposer(props: Props) {
  const { garments, inTrash = NONE, outfits, wears, byId, ix, day, todayKey, workDays = NO_DAYS, onDay, onLog, onRemoveLook, onSaveOutfit, onAdd, onOpenPiece, pending, onPendingUsed } =
    props
  const [frozen] = useState(() => byRest(garments, ix).map(g => g.id))
  const dayLooks = looksOn(wears, day)
  const latest = dayLooks[dayLooks.length - 1]
  /** A day turned the other way than the calendar has it: for the view only, never saved. */
  const [flip, setFlip] = useState<{ day: string; to: DayOccasion } | null>(null)
  const calendarSays = dayOccasion(day, workDays)
  const occasion = flip?.day === day ? flip.to : calendarSays
  const held = useMemo(() => heldPieces(latest, garments, inTrash), [latest, garments, inTrash])
  const rows = useMemo(() => rowsOf(garments, frozen, held, occasion), [garments, frozen, held, occasion])
  const shown = useMemo(() => shownIn(rows), [rows])
  const [sel, setSel] = useState<Selection>(() => {
    const first = start(rows, latest, byId)
    return pending ? load(first, pending, rows, byId) : first
  })
  const [openRows, setOpenRows] = useState<Optional[]>(storedRows)
  /** The note of the day's latest look: what the note field is filled with. */
  const lookNote = latest?.note ?? ''
  const [note, setNote] = useState(lookNote)
  const cached = useCachedForecast()
  const forecast = props.forecast !== undefined ? props.forecast : cached

  // a day with a look brings its pieces into the rows; a day without one
  // keeps what is chosen, so a look put together here can be logged for
  // yesterday or planned for tomorrow
  const shownDay = useRef(day)
  useEffect(() => {
    if (shownDay.current === day) return
    shownDay.current = day
    setSel(s => (latest ? load(s, latest.garmentIds, rows, byId) : { ...s, note: undefined }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day])
  // the note field follows the day's latest look — another day's, a log, a
  // Remove, an Undo, a sync — and a note typed with no look to follow stays,
  // as the rows do
  useEffect(() => setNote(lookNote), [latest?.id, lookNote])

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
  // the rows move and nothing is written: Wearing this is still yours to press
  const shuffle = () => setSel(s => surprise(s, rows, openRows, ix, { season: seasonOf(day), occasion }))
  const flipDay = () => setFlip(occasion === calendarSays ? { day, to: otherOccasion(occasion) } : null)
  const canShuffle = (onepieceMode ? rows.onepiece : [...rows.top, ...rows.bottom]).length > 0

  const yesterday = shiftDayKey(todayKey, -1)
  const tomorrow = shiftDayKey(todayKey, 1)
  const lastDay = lastPlanDay(todayKey)
  const dayName = `${day === todayKey ? 'Today · ' : day === yesterday ? 'Yesterday · ' : day === tomorrow ? 'Tomorrow · ' : ''}${shortDay(day, todayKey)}`
  const ahead = day > todayKey
  const planned = !!latest?.planned
  const worn = !!latest && !planned
  // a plan on a day that has come is confirmed by logging it, so it reads as a day not yet logged
  const primary = ahead ? (latest ? 'Update plan' : `Plan for ${shortDay(day, todayKey)}`) : worn ? 'Update look' : day === todayKey ? 'Wearing this' : `Log for ${shortDay(day, todayKey)}`
  const another = ahead ? !!latest : worn
  // an evening change is a look of its own: it takes a note only when one was
  // written for it, never the day's note the field was filled with
  const anotherNote = note.trim() === lookNote ? '' : note

  // what today's forecast asks for, when the rows have no outerwear chosen yet
  const need = day === todayKey ? weatherNeed(forecast) : null
  const coat = need && !chosen.outerwear ? outerwearFor(garments, ix, need, undefined, occasion) : undefined

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
        occasion={occasion}
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
        {/* the date and what the day is dressed for: side by side, or on a
            phone one over the other, so the line stays one line */}
        <span className="wardrobe-day-mid">
          <span className="wardrobe-day-pick">
            <span className="wardrobe-day-name" aria-hidden="true">
              {dayName}
            </span>
            <input
              type="date"
              max={lastDay}
              value={day}
              aria-label={`Day: ${dayName}`}
              onChange={e => {
                const v = e.target.value
                // a year ahead at most: a plan, not a diary
                if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= lastDay) onDay(v)
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
          <button
            type="button"
            className={occasion === calendarSays ? 'wardrobe-occasion' : 'wardrobe-occasion changed'}
            aria-label={`${DAY_OCCASION_LABEL[occasion]}${occasion === calendarSays ? '' : ', changed for now'}: dress for ${occasion === 'work' ? 'a day off' : 'work'} instead`}
            title={occasion === calendarSays ? (occasion === 'work' ? 'A work day on your calendar' : 'No work day on your calendar') : 'Changed for now: nothing is saved'}
            onClick={flipDay}
          >
            {DAY_OCCASION_LABEL[occasion]}
          </button>
        </span>
        <button type="button" className="btn subtle wardrobe-step" aria-label="The day after" disabled={day >= lastDay} onClick={() => onDay(shiftDayKey(day, 1))}>
          ›
        </button>
        {latest && (
          <span className="wardrobe-day-state">
            <span className={planned ? 'badge wardrobe-planned' : 'badge wardrobe-logged'}>{planned ? 'Planned' : 'Logged'}</span>
            <ConfirmButton className="btn subtle danger wardrobe-remove" confirmLabel="Remove?" ariaLabel={planned ? 'Remove plan' : 'Remove look'} onConfirm={() => onRemoveLook(day)}>
              Remove<span className="wardrobe-remove-more">{planned ? ' plan' : ' look'}</span>
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
      {forecast && need && coat && (
        <p className="wardrobe-weather">
          {weatherLine(forecast, need)}
          <button type="button" className="toggle" onClick={() => pick('outerwear', coat.id)}>
            Add {coat.name}
          </button>
        </p>
      )}
      {(both || OPTIONAL.some(s => !rowOpen(s)) || canShuffle) && (
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
          {canShuffle && (
            <button type="button" className="toggle wardrobe-surprise" onClick={shuffle}>
              <Icon name="shuffle" size={14} /> Surprise me
            </button>
          )}
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
                  {g.favourite && <FavouriteMark inline />}
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
      <label className="field wardrobe-look-note">
        <span>Note on the look</span>
        <input value={note} maxLength={LOOK_NOTE_MAX} placeholder="wedding, interview…" onChange={e => setNote(e.target.value)} />
      </label>

      <div className="wardrobe-actions">
        <button type="button" className="btn" disabled={!dressed} onClick={() => onSaveOutfit(pieces)}>
          Save outfit
        </button>
        <span className="spacer" />
        {another && (
          // "+ Look" on a phone, where the three share one row
          <button type="button" className="btn" aria-label="Another look" disabled={!dressed} onClick={() => onLog(day, pieces, { shown, another: true, note: anotherNote })}>
            + <span className="wardrobe-another-long">Another look</span>
            <span className="wardrobe-another-short">Look</span>
          </button>
        )}
        <button type="button" className="btn primary" disabled={!dressed} onClick={() => onLog(day, pieces, { shown, note })}>
          {primary}
        </button>
      </div>

      <SavedOutfits
        outfits={outfits}
        byId={byId}
        ix={ix}
        onLoad={loadOutfit}
        onWear={props.onWearOutfit}
        onRename={props.onRenameOutfit}
        onFavourite={props.onFavouriteOutfit}
        onDelete={props.onDeleteOutfit}
      />
    </div>
  )
}
