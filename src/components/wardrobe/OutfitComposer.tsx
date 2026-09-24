import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { shiftDayKey } from '../../journal'
import { shortDay } from '../../kitchen'
import { LOOK_NOTE_MAX, type Garment, type GarmentType, type Outfit, type Wear } from '../../types'
import {
  canDress,
  DAY_OCCASION_LABEL,
  dayOccasion,
  dayWeather,
  lastPlanDay,
  looksOn,
  otherOccasion,
  outerwearFor,
  outfitLabel,
  seasonOf,
  weatherLine,
  weatherNeed,
  type DayOccasion,
  type WearIndex,
} from '../../wardrobe'
import type { Forecast } from '../../weather'
import { ConfirmButton } from '../ConfirmButton'
import { Icon } from '../Icon'
import { Segmented } from '../stats/Segmented'
import { daysToPlan, dealIdeas, weekOf, weekRange, weekTaken, type PlanSource } from './board'
import { chosenIn, heldBadge, heldPieces, load, loadIdea, OPTIONAL, pickSlot, rowsOf, shownIn, start, toggleAccessory, type Optional, type Selection, type Slot } from './composer'
import { useCachedForecast } from './forecast'
import { Collage, FavouriteMark, GarmentPhoto } from './GarmentPhoto'
import { EmptySlot, FilledSlot } from './LookSlot'
import { PiecePicker } from './PiecePicker'
import { PlanWeekSheet } from './PlanWeekSheet'
import { SavedOutfits } from './SavedOutfits'
import { WeekStrip } from './WeekStrip'

/** Which of the optional slots are open: this device's preference, like the journal's stats. */
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

/** The ideas' deal: moved on by New ideas, for the day and the occasion it was dealt for. */
interface IdeaDeal {
  day: string
  occasion: DayOccasion
  n: number
  /** The looks of the deal before, and their pieces: the next deal steers off them. */
  last: string[]
  avoid: string[]
}

interface Props {
  garments: Garment[]
  /** Pieces in Trash: a day whose look still holds one shows it in its slot. */
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
   * Log the pieces on the day: the look being edited takes them, or with
   * `another` a new look does; a day still to come is planned rather than
   * logged. `shown` is every piece the card can hold, so whatever else that
   * look holds stays. `note` is the look's note, as its field says it.
   */
  onLog(day: string, pieces: string[], opts: { shown: ReadonlySet<string>; another?: boolean; note?: string; wearId?: string }): void
  /** Remove the look being edited (`wearId`), or the day's latest if none is named. */
  onRemoveLook(day: string, wearId?: string): void
  /** Plan the week: a planned look for each day, as one batch with one Undo. */
  onPlanWeek(plans: { day: string; pieces: string[] }[]): void
  /** A way in from Today: this look of the day, or a new change. Consumed once. */
  focus?: { wearId?: string; another?: true } | null
  onFocusConsumed?(): void
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
  /** A saved outfit asked for from outside (the palette's search): put on the card once, then handed back as used. */
  pending?: readonly string[] | null
  onPendingUsed?(): void
}

/**
 * Outfit: the day's whole look on one card. The week it is in runs across the
 * top — a dot on each day with a look worn, a ring on each with a plan — with
 * Plan the week beside it; under that, what the day is dressed for and, today,
 * the weather. The card holds a slot for each piece, top to toe: the top and
 * the bottom (or a one-piece), outerwear and shoes when they are on, asked
 * for or suggested by a cold or wet forecast, and the accessories as chips.
 * A tap on a slot opens its picker; an empty slot is a slim row that asks for
 * one. A day with a look has a switcher: flip the day's changes, or + Another
 * look to start the next one. Ideas for the day and your saved outfits sit
 * underneath, and a tap puts either on the card; Wearing this, or Save outfit,
 * waits in a bar that stays in reach above the tab bar.
 *
 * A day's look is shown as it is: a retired piece in it, or one in Trash,
 * holds its slot for the visit, badged, so Update look never writes over what
 * you cannot see. A day still to come is planned: its look counts once it is
 * said to be worn.
 *
 * The day is a Work day (a work-day entry of yours is on the calendar) or a
 * Day off; a tap turns it the other way for this visit and saves nothing. The
 * picker leads with the pieces for it, or for any time; the ideas, the plan
 * and the coat keep to it.
 */
export function OutfitComposer(props: Props) {
  const {
    garments,
    inTrash = NONE,
    outfits,
    wears,
    byId,
    ix,
    day,
    todayKey,
    workDays = NO_DAYS,
    onDay,
    onLog,
    onRemoveLook,
    onPlanWeek,
    onSaveOutfit,
    onAdd,
    onOpenPiece,
    pending,
    onPendingUsed,
    focus,
    onFocusConsumed,
  } = props
  const dayLooks = looksOn(wears, day)
  const latest = dayLooks[dayLooks.length - 1]
  /** The look of this day being dressed, or `new` for the next change. */
  const [editingId, setEditingId] = useState<string | 'new' | null>(() => (focus?.another ? 'new' : (focus?.wearId ?? null)))
  const resolvedId = editingId === 'new' ? 'new' : editingId && dayLooks.some(w => w.id === editingId) ? editingId : (latest?.id ?? null)
  const isDraft = resolvedId === 'new'
  const current = isDraft ? undefined : dayLooks.find(w => w.id === resolvedId) ?? latest
  /** A day turned the other way than the calendar has it: for the view only, never saved. */
  const [flip, setFlip] = useState<{ day: string; to: DayOccasion } | null>(null)
  const calendarSays = dayOccasion(day, workDays)
  const occasion = flip?.day === day ? flip.to : calendarSays
  // memoised by the React Compiler: the state below is adjusted as it renders,
  // which a hand-written useMemo over `current` could not be kept across
  const held = heldPieces(current, garments, inTrash)
  const rows = rowsOf(garments, held)
  const shown = shownIn(rows)
  const [sel, setSel] = useState<Selection>(() => {
    const first = start(rows, isDraft ? undefined : current ?? latest, byId)
    return pending ? load(first, pending, rows, byId) : first
  })
  const [openRows, setOpenRows] = useState<Optional[]>(storedRows)
  /** The note of the look being dressed: what the note field is filled with. */
  const lookNote = current?.note ?? ''
  const [note, setNote] = useState(lookNote)
  /** Add a note pressed: the field shows though the look has none yet. */
  const [noteOpen, setNoteOpen] = useState(false)
  const cached = useCachedForecast()
  const forecast = props.forecast !== undefined ? props.forecast : cached
  /** The slot whose picker is open. */
  const [picking, setPicking] = useState<Slot | null>(null)
  const [planning, setPlanning] = useState(false)
  /** The pieces shown by their other side, for this visit. */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set())
  /** Today's coat, waved away for the visit. */
  const [noCoat, setNoCoat] = useState(false)
  const [ideaDeal, setIdeaDeal] = useState<IdeaDeal | null>(null)
  /** The card: an idea or a saved outfit tapped under it brings it back into view. */
  const card = useRef<HTMLElement>(null)

  // What changes around the board is taken as the change renders, in this
  // order, each against what it last saw (what the state above started from
  // counts as seen). A day with a look puts its pieces on the card; a day
  // without one keeps what is on it, so a look put together here can be
  // logged for yesterday or planned for tomorrow.
  const [shownDay, setShownDay] = useState(day)
  if (shownDay !== day) {
    setShownDay(day)
    setEditingId(null)
    setSel(s => (latest ? load(s, latest.garmentIds, rows, byId) : { ...s, note: undefined }))
  }
  // a way in names a look of this day, or asks for a new change
  const [focusSeen, setFocusSeen] = useState(focus)
  if (focusSeen !== focus) {
    setFocusSeen(focus)
    if (focus?.another) {
      setEditingId('new')
      setSel(start(rows, undefined, byId))
      setNote('')
    } else if (focus?.wearId && dayLooks.some(w => w.id === focus.wearId)) setEditingId(focus.wearId)
  }
  // once per way in: an effect event, so the parent's setter is not a reason to run again
  const focusUsed = useEffectEvent(() => onFocusConsumed?.())
  useEffect(() => {
    if (focus) focusUsed()
  }, [focus])
  const [shownLook, setShownLook] = useState(resolvedId)
  if (shownLook !== resolvedId) {
    setShownLook(resolvedId)
    setSel(s => (current ? load(s, current.garmentIds, rows, byId) : start(rows, undefined, byId)))
    setNote(lookNote)
    setNoteOpen(false)
  }
  // the note field follows the look being dressed — another look, a log, a
  // Remove, an Undo, a sync — and a note typed with no look to follow stays,
  // as the card does
  const [noteFor, setNoteFor] = useState({ id: current?.id, lookNote })
  if (noteFor.id !== current?.id || noteFor.lookNote !== lookNote) {
    setNoteFor({ id: current?.id, lookNote })
    setNote(lookNote)
  }

  // a saved outfit asked for from outside goes on the card once — after the
  // day's own look, so it is what shows — and is handed back as used, so
  // coming back to Outfit later does not put it there again
  const [pendingSeen, setPendingSeen] = useState(pending)
  if (pendingSeen !== pending) {
    setPendingSeen(pending)
    if (pending) setSel(s => load(s, pending, rows, byId))
  }
  // once per outfit asked for, as the way in above
  const pendingUsed = useEffectEvent(() => onPendingUsed?.())
  useEffect(() => {
    if (pending) pendingUsed()
  }, [pending])

  const { slots: chosen, accessories, both, onepieceMode, open, pieces, dressed } = chosenIn(sel, rows, openRows)

  const pick = (slot: Slot, id: string | null) => setSel(s => pickSlot(s, slot, id))
  const keepRows = (next: Optional[]) => {
    setOpenRows(next)
    try {
      localStorage.setItem(ROWS_KEY, JSON.stringify(next))
    } catch {
      /* a preference, not data */
    }
  }
  const openRow = (s: Optional) => keepRows([...openRows.filter(x => x !== s), s])
  const closeRow = (s: Optional) => {
    keepRows(openRows.filter(x => x !== s))
    pick(s, null)
  }
  /** A slot's picker, or — with nothing of its type yet — Add clothing for one. */
  const choose = (slot: Slot) => (rows[slot].length > 0 ? setPicking(slot) : onAdd(slot))
  const flipSide = (id: string) =>
    setFlipped(was => {
      const next = new Set(was)
      if (!next.delete(id)) next.add(id)
      return next
    })
  /** The card back in view, when what was just put on it is out of sight (a phone, scrolled down to the ideas). */
  const showCard = () => card.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  const loadOutfit = (o: Outfit) => {
    setSel(s => load(s, o.garmentIds, rows, byId))
    showCard()
  }
  const tryIdea = (ids: readonly string[]) => {
    setSel(s => loadIdea(s, ids, rows))
    showCard()
  }
  const flipDay = () => setFlip(occasion === calendarSays ? { day, to: otherOccasion(occasion) } : null)

  const yesterday = shiftDayKey(todayKey, -1)
  const tomorrow = shiftDayKey(todayKey, 1)
  const lastDay = lastPlanDay(todayKey)
  const dayName = `${day === todayKey ? 'Today · ' : day === yesterday ? 'Yesterday · ' : day === tomorrow ? 'Tomorrow · ' : ''}${shortDay(day, todayKey)}`
  const ahead = day > todayKey
  const planned = !!current?.planned
  const worn = !!current && !planned
  // a plan on a day that has come is confirmed by logging it, so it reads as a day not yet logged
  const primary = isDraft
    ? ahead
      ? `Plan for ${shortDay(day, todayKey)}`
      : day === todayKey
        ? 'Wearing this'
        : `Log for ${shortDay(day, todayKey)}`
    : ahead
      ? current
        ? 'Update plan'
        : `Plan for ${shortDay(day, todayKey)}`
      : worn
        ? 'Update look'
        : day === todayKey
          ? 'Wearing this'
          : `Log for ${shortDay(day, todayKey)}`
  const lookAt = current ? dayLooks.findIndex(w => w.id === current.id) : -1
  const lookMid = isDraft
    ? dayLooks.length
      ? `New look · ${dayLooks.length + 1} of ${dayLooks.length + 1}`
      : 'New look'
    : current
      ? `${current.note ? `${current.note} · ` : 'Look '}${lookAt + 1} of ${dayLooks.length}`
      : ''
  const logOpts = (asAnother: boolean) => ({
    shown,
    another: asAnother || undefined,
    note: asAnother && note.trim() === lookNote ? '' : note,
    wearId: asAnother ? undefined : current?.id,
  })
  const saveLook = (asAnother: boolean) => {
    onLog(day, pieces, logOpts(asAnother))
    if (asAnother) setEditingId(null)
  }
  const startAnother = () => {
    setEditingId('new')
    setSel(start(rows, undefined, byId))
    setNote('')
  }

  // today's forecast: the day line's words, and the coat a cold or wet day asks for
  const need = day === todayKey ? weatherNeed(forecast) : null
  const dayCoat = need ? outerwearFor(garments, ix, need, undefined, occasion) : undefined
  const coat = dayCoat && !chosen.outerwear && !noCoat ? dayCoat : undefined
  const sky = day === todayKey && forecast ? dayWeather(forecast) : ''

  // three ideas for the day, dealt from a seed: the same three every time the
  // board draws, until New ideas deals three more
  const deal = ideaDeal && ideaDeal.day === day && ideaDeal.occasion === occasion ? ideaDeal : { n: 0, last: [], avoid: [] }
  const ideas = canDress(garments) ? dealIdeas(rows, ix, { occasion, season: seasonOf(day), coat: dayCoat, last: deal.last, avoid: deal.avoid, seed: `ideas|${day}|${occasion}|${deal.n}` }) : []
  const moreIdeas = () => setIdeaDeal({ day, occasion, n: deal.n + 1, last: ideas.map(i => i.key), avoid: ideas.flatMap(i => i.core) })
  const ideasFor = day === todayKey ? 'today' : day === tomorrow ? 'tomorrow' : day === yesterday ? 'yesterday' : shortDay(day, todayKey)

  // the shown week's days still to plan, and what they are dealt from
  const week = weekOf(day)
  const toPlan = daysToPlan(week, wears, todayKey, lastDay)
  const canPlan = toPlan.length > 0 && canDress(garments)
  const todayNeed = weatherNeed(forecast)
  const occasionOf = (d: string): DayOccasion => (flip?.day === d ? flip.to : dayOccasion(d, workDays))
  const planSource: PlanSource = {
    rows,
    ix,
    occasionOf,
    coatOf: d => (d === todayKey && todayNeed ? outerwearFor(garments, ix, todayNeed, undefined, occasionOf(d)) : undefined),
  }

  const filled = (slot: Slot, clear: () => void) => {
    const g = rows[slot].find(x => x.id === chosen[slot])!
    return <FilledSlot key={slot} garment={g} ix={ix} occasion={occasion} flipped={flipped.has(g.id)} onFlip={() => flipSide(g.id)} onOpen={() => choose(slot)} onClear={clear} />
  }
  const core = (slot: Slot) => (chosen[slot] ? filled(slot, () => pick(slot, null)) : <EmptySlot key={slot} slot={slot} onOpen={() => choose(slot)} />)
  // outerwear and shoes: on when they hold a piece, when asked for, or — the
  // outerwear — when today's forecast suggests a coat, named, a tap from on
  const optional = (s: Optional) => {
    if (chosen[s]) return filled(s, () => pick(s, null))
    if (s === 'outerwear' && coat && forecast && need)
      return (
        <EmptySlot
          key={s}
          slot={s}
          suggest={coat}
          why={weatherLine(forecast, need)}
          onOpen={() => pick('outerwear', coat.id)}
          onClose={() => {
            setNoCoat(true)
            if (openRows.includes(s)) closeRow(s)
          }}
        />
      )
    if (open.includes(s)) return <EmptySlot key={s} slot={s} onOpen={() => choose(s)} onClose={() => closeRow(s)} />
    return null
  }
  const closed = OPTIONAL.filter(s => !open.includes(s) && !(s === 'outerwear' && coat))

  return (
    <div className="outfit-board">
      <div className="board-main">
        <WeekStrip day={day} todayKey={todayKey} lastDay={lastDay} wears={wears} dayName={dayName} onDay={onDay} />
        <div className="wardrobe-dayline">
          <button
            type="button"
            className={occasion === calendarSays ? 'wardrobe-occasion' : 'wardrobe-occasion changed'}
            aria-label={`${DAY_OCCASION_LABEL[occasion]}${occasion === calendarSays ? '' : ', changed for now'}: dress for ${occasion === 'work' ? 'a day off' : 'work'} instead`}
            title={occasion === calendarSays ? (occasion === 'work' ? 'A work day on your calendar' : 'No work day on your calendar') : 'Changed for now: nothing is saved'}
            onClick={flipDay}
          >
            {DAY_OCCASION_LABEL[occasion]}
          </button>
          {sky && <span className="wardrobe-sky">{sky}</span>}
          <button
            type="button"
            className="btn wardrobe-plan"
            disabled={!canPlan}
            title={canPlan ? 'A look for each day left this week' : 'Every day left this week has a look'}
            onClick={() => setPlanning(true)}
          >
            Plan the week
          </button>
        </div>

        <section ref={card} className="look-card" aria-label={`The look for ${dayName}`}>
          <header className="look-head">
            <h3 className="look-day">{dayName}</h3>
            {current && <span className={planned ? 'badge wardrobe-planned' : 'badge wardrobe-logged'}>{planned ? 'Planned' : 'Logged'}</span>}
            {dayLooks.length > 0 && (
              <button type="button" className="btn subtle look-another" aria-label="Another look" disabled={isDraft} onClick={startAnother}>
                <span className="wardrobe-another-long">+ Another look</span>
                <span className="wardrobe-another-short">+ Look</span>
              </button>
            )}
          </header>
          {(dayLooks.length > 1 || isDraft) && (
            <div className="wardrobe-looks">
              <button
                type="button"
                className="btn subtle wardrobe-step"
                aria-label="The look before"
                disabled={isDraft ? dayLooks.length === 0 : lookAt <= 0}
                onClick={() => {
                  if (isDraft && dayLooks.length) setEditingId(dayLooks[dayLooks.length - 1].id)
                  else if (lookAt > 0) setEditingId(dayLooks[lookAt - 1].id)
                }}
              >
                ‹
              </button>
              <span className="wardrobe-looks-mid">{lookMid}</span>
              <button
                type="button"
                className="btn subtle wardrobe-step"
                aria-label="The look after"
                disabled={isDraft || lookAt < 0 || lookAt >= dayLooks.length - 1}
                onClick={() => lookAt >= 0 && lookAt < dayLooks.length - 1 && setEditingId(dayLooks[lookAt + 1].id)}
              >
                ›
              </button>
            </div>
          )}
          {both && (
            <Segmented
              role="group"
              items={[
                { key: 'separates', label: 'Separates' },
                { key: 'onepiece', label: 'One-piece' },
              ]}
              value={onepieceMode ? 'onepiece' : 'separates'}
              onChange={k => setSel(s => ({ ...s, onepiece: k === 'onepiece' }))}
              label="Separates or a one-piece"
              className="wardrobe-mode"
            />
          )}
          <ul className="look-slots">
            {onepieceMode ? core('onepiece') : [core('top'), core('bottom')]}
            {OPTIONAL.map(optional)}
          </ul>
          {rows.accessory.length > 0 && (
            <div className="wardrobe-acc">
              <span className="look-label">Accessories</span>
              <div className="wardrobe-acc-chips" role="group" aria-label="Accessories">
                {rows.accessory.map(g => {
                  const on = accessories.includes(g.id)
                  const badge = heldBadge(g)
                  return (
                    <button key={g.id} type="button" aria-pressed={on} className={on ? 'toggle on acc-chip' : 'toggle acc-chip'} onClick={() => setSel(s => toggleAccessory(s, g.id))}>
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
          {closed.length > 0 && (
            <div className="look-more">
              {closed.map(s => (
                <button key={s} type="button" className="toggle" onClick={() => openRow(s)}>
                  + {s === 'outerwear' ? 'Outerwear' : 'Shoes'}
                </button>
              ))}
            </div>
          )}
          <div className="look-foot">
            {noteOpen || lookNote ? (
              <label className="wardrobe-look-note">
                <span className="wardrobe-sr">Note on the look</span>
                <input value={note} maxLength={LOOK_NOTE_MAX} placeholder="wedding, interview…" autoComplete="off" onChange={e => setNote(e.target.value)} />
              </label>
            ) : (
              <button type="button" className="btn subtle look-note-add" onClick={() => setNoteOpen(true)}>
                Add a note
              </button>
            )}
            {current && (
              <ConfirmButton
                className="btn subtle danger wardrobe-remove"
                confirmLabel="Remove?"
                ariaLabel={planned ? 'Remove plan' : 'Remove look'}
                onConfirm={() => {
                  onRemoveLook(day, current.id)
                  setEditingId(null)
                }}
              >
                {planned ? 'Remove plan' : 'Remove look'}
              </ConfirmButton>
            )}
          </div>
        </section>

        <div className="wardrobe-actions">
          <button type="button" className="btn" disabled={!dressed} onClick={() => onSaveOutfit(pieces)}>
            Save outfit
          </button>
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={!dressed} onClick={() => saveLook(isDraft)}>
            {primary}
          </button>
        </div>
      </div>

      <div className="board-side">
        {ideas.length > 0 && (
          <section className="wardrobe-ideas" aria-label={`Ideas for ${ideasFor}`}>
            <div className="board-head">
              <h3 className="wardrobe-heading">Ideas for {ideasFor}</h3>
              <button type="button" className="btn subtle board-refresh" onClick={moreIdeas}>
                <Icon name="shuffle" size={14} /> New ideas
              </button>
            </div>
            <ul className="idea-strip">
              {ideas.map(idea => (
                <li key={idea.key}>
                  <button type="button" className="idea-tile" aria-label={`Try ${outfitLabel(idea.ids, byId)}`} onClick={() => tryIdea(idea.ids)}>
                    <Collage ids={idea.ids} byId={byId} />
                    <span className="idea-label">{outfitLabel(idea.core, byId)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
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

      {picking && (
        <PiecePicker
          key={picking}
          slot={picking}
          pieces={rows[picking]}
          current={chosen[picking]}
          occasion={occasion}
          ix={ix}
          onPick={id => {
            pick(picking, id)
            setPicking(null)
          }}
          onAdd={() => {
            setPicking(null)
            onAdd(picking)
          }}
          onOpenPiece={onOpenPiece}
          onClose={() => setPicking(null)}
        />
      )}
      {planning && (
        <PlanWeekSheet
          days={toPlan}
          week={weekRange(week, todayKey)}
          todayKey={todayKey}
          source={planSource}
          taken={weekTaken(week, wears, byId)}
          byId={byId}
          onPlan={onPlanWeek}
          onClose={() => setPlanning(false)}
        />
      )}
    </div>
  )
}
