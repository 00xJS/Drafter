import { useEffect, useMemo, useRef, useState } from 'react'
import { haptic } from '../../native'
import { LOOK_NAME_HINTS, LOOK_NOTE_MAX, type Garment, type Outfit, type Wear } from '../../types'
import {
  canDress,
  confirmed,
  forgotYesterday,
  hasOuterwear,
  liveById,
  newWear,
  orderPieces,
  outerwearFor,
  outfitLabel,
  planFor,
  todaySuggestions,
  wearIndex,
  weatherLine,
  weatherNeed,
  withNote,
  withPieces,
} from '../../wardrobe'
import type { Forecast } from '../../weather'
import type { WardrobeOpen } from '../planner/useNavigation'
import { useCachedForecast } from './forecast'
import { useFold } from '../HomeFold'
import { Collage, GarmentPhoto } from './GarmentPhoto'

/** How the shell is to save what the card logs: for an edit, the look as it was, which Undo writes back; and the toast (null: none). */
export interface CardLog {
  before?: Wear
  msg?: string | null
}

interface Props {
  garments: Garment[]
  outfits: Outfit[]
  wears: Wear[]
  /** Today, as a local day key. */
  dayKey: string
  /**
   * A look to save: a new one from a chip, whose Undo removes it, or an edit
   * of today's look or plan — the plan said to be worn, a note, a coat added —
   * whose Undo writes `before` back. The shell saves it and offers Undo.
   */
  onLog(w: Wear, opts?: CardLog): void
  /** Pick…, Change and Forgot yesterday: Home → Wardrobe on a day. */
  onOpen(o: WardrobeOpen): void
  /**
   * The clock "before noon" is read from: Home's minute (useNow). Never a
   * default read here — the React Compiler would keep the time the card first
   * drew for as long as Home stays up.
   */
  now: Date
  /** Today's forecast; by default the one the briefing cached (the tests hand one in). */
  forecast?: Forecast | null
  /** A work day on your calendar: the one-tap looks that fit it come first, and so does a coat that does. */
  workDay?: boolean
}

/**
 * A look's note on the card: the note itself, or "+ Note", and a tap to write
 * it in place — kept on Enter or when the field is left, and left be on Escape.
 */
function LookNote({ look, onSave }: { look: Wear; onSave(note: string): void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const field = useRef<HTMLInputElement>(null)
  // open until Enter, Escape or the blur closes it, so Enter and the blur after it save once
  const open = useRef(false)
  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])
  const finish = (save: boolean) => {
    if (!open.current) return
    open.current = false
    setEditing(false)
    if (save && text.trim() !== (look.note ?? '')) onSave(text)
  }
  if (!editing) {
    return (
      <button
        type="button"
        className={look.note ? 'wardrobe-card-note has-note' : 'wardrobe-card-note'}
        title={look.note ? 'Change the note' : 'A note on the look: a wedding, an interview'}
        onClick={() => {
          open.current = true
          setText(look.note ?? '')
          setEditing(true)
        }}
      >
        {look.note || '+ Note'}
      </button>
    )
  }
  return (
    <input
      ref={field}
      className="wardrobe-card-note-input"
      value={text}
      maxLength={LOOK_NOTE_MAX}
      placeholder="wedding, interview…"
      aria-label="Note on the look"
      onChange={e => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          finish(e.key === 'Enter')
        }
      }}
    />
  )
}

/**
 * Today's "What are you wearing?": up to three looks — saved outfits and what
 * you wear most — each logged with one tap, and Pick… for anything else. A day
 * planned ahead shows its plan instead, with one tap to say it was worn. Once
 * today has a look the latest is Wearing, earlier ones stay in a stack, and
 * + Look starts the next change. When the forecast is cold or wet, it offers
 * a coat. Hidden until the wardrobe can dress you (a top and a bottom, or a
 * one-piece), so nobody without one is asked. The one tap is the only thing
 * in the wardrobe that buzzes. On a work day the looks whose pieces are all
 * for work, or for any time, come first.
 */
export function WardrobeCard({ garments, outfits, wears, dayKey, onLog, onOpen, now, forecast: given, workDay = false }: Props) {
  const byId = useMemo(() => liveById(garments), [garments])
  const ix = useMemo(() => wearIndex(wears, dayKey), [wears, dayKey])
  const chips = useMemo(() => todaySuggestions(ix, outfits, byId, 3, workDay ? 'work' : undefined), [ix, outfits, byId, workDay])
  const cached = useCachedForecast()
  const [withCoat, setWithCoat] = useState(false)
  /* Only the headed form below folds. Once the day is dressed this card is a
     single line with no heading at all, and folding a card with no heading
     would leave nothing on the screen to open it again. */
  const fold = useFold('wardrobe', 'What are you wearing?')
  if (!canDress(garments)) return null

  const forecast = given !== undefined ? given : cached
  const need = weatherNeed(forecast)
  const coat = need ? outerwearFor(garments, ix, need, undefined, workDay ? 'work' : 'personal') : undefined
  const sky = forecast && need ? weatherLine(forecast, need) : ''
  /** The one tap: a look logged, or a plan said to be worn. */
  const tap = (w: Wear, before?: Wear) => {
    void haptic('light')
    onLog(w, before ? { before } : undefined)
  }
  const thumbs = (ids: readonly string[]) => (
    <span className="wardrobe-card-thumbs" aria-hidden="true">
      {orderPieces(ids, byId)
        .slice(0, 3)
        .map(id => (
          <GarmentPhoto key={id} garment={byId.get(id)!} />
        ))}
    </span>
  )
  const noteOn = (look: Wear) => <LookNote key={look.id} look={look} onSave={note => onLog(withNote(look, note), { before: look, msg: null })} />
  // the morning's question about yesterday stands whether today is planned or not
  const yesterday = forgotYesterday(ix, now.getHours())
  const forgot = yesterday && (
    <button type="button" className="wardrobe-forgot" onClick={() => onOpen({ date: yesterday })}>
      Forgot yesterday? Log it
    </button>
  )

  const today = ix.looks.get(dayKey)
  if (today?.length) {
    const look = today[today.length - 1]
    const earlier = today.slice(0, -1)
    return (
      <section className="chart-card wardrobe-card logged">
        {earlier.length > 0 && (
          <ul className="wardrobe-card-stack">
            {earlier.map((w, i) => (
              <li key={w.id}>
                <button type="button" className="wardrobe-card-prior" onClick={() => onOpen({ tab: 'outfit', date: dayKey, wearId: w.id })}>
                  {thumbs(w.garmentIds)}
                  <span className="wardrobe-card-line">
                    <span className="muted">{w.note || `Look ${i + 1}`}</span>
                    {w.note ? ` · ${outfitLabel(w.garmentIds, byId)}` : ` ${outfitLabel(w.garmentIds, byId)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="wardrobe-card-look">
          {thumbs(look.garmentIds)}
          <p className="wardrobe-card-line">
            <span className="muted">Wearing</span>
            {look.note ? ` ${look.note} ·` : ''} {outfitLabel(look.garmentIds, byId)}
          </p>
          <button type="button" className="btn subtle" onClick={() => onOpen({ tab: 'outfit', date: dayKey, wearId: look.id })}>
            Change
          </button>
        </div>
        {noteOn(look)}
        {earlier.length > 0 && !look.note && (
          <div className="wardrobe-card-names" role="group" aria-label="Name this look">
            {LOOK_NAME_HINTS.map(name => (
              <button key={name} type="button" className="toggle" onClick={() => onLog(withNote(look, name), { before: look, msg: null })}>
                {name}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="btn subtle wardrobe-card-add" aria-label="Another look" onClick={() => onOpen({ tab: 'outfit', date: dayKey, another: true })}>
          + Look
        </button>
      </section>
    )
  }

  const plan = planFor(wears, dayKey)
  if (plan) {
    const addCoat = coat && !hasOuterwear(plan.garmentIds, byId) ? coat : undefined
    return (
      <section className="chart-card wardrobe-card logged planned">
        <div className="wardrobe-card-look">
          {thumbs(plan.garmentIds)}
          <p className="wardrobe-card-line">
            <span className="muted">Planned:</span> {outfitLabel(plan.garmentIds, byId)}
          </p>
          <button type="button" className="btn subtle" onClick={() => onOpen({ date: dayKey })}>
            Change
          </button>
        </div>
        {addCoat && (
          <p className="wardrobe-weather">
            {sky}
            <button
              type="button"
              className="toggle"
              onClick={() => onLog(withPieces(plan, [...plan.garmentIds, addCoat.id]), { before: plan, msg: `${addCoat.name} added to the plan` })}
            >
              Add {addCoat.name}
            </button>
          </p>
        )}
        <div className="wardrobe-card-foot">
          {noteOn(plan)}
          <button type="button" className="btn primary" onClick={() => tap(confirmed(plan), plan)}>
            Wore it
          </button>
        </div>
        <button type="button" className="btn subtle wardrobe-card-add" aria-label="Another look" onClick={() => onOpen({ tab: 'outfit', date: dayKey, another: true })}>
          + Look
        </button>
        {forgot}
      </section>
    )
  }

  // with the coat asked for, each look takes it, unless it has outerwear of its own
  const dressed = (ids: string[]) => (withCoat && coat && !hasOuterwear(ids, byId) ? [...ids, coat.id] : ids)
  return (
    <section className={'chart-card wardrobe-card' + fold.className}>
      <header className="chart-head">
        <div>
          <h3>What are you wearing?</h3>
          <p className="chart-sub">Tap one to log it, or pick</p>
        </div>
        {fold.control}
      </header>
      {/* the coat rides on the one-tap looks; with none to ride on, Pick… opens
          Outfit, which offers it for today itself */}
      {coat && sky && chips.length > 0 && (
        <p className="wardrobe-weather">
          {sky}
          <button type="button" aria-pressed={withCoat} className={withCoat ? 'toggle on' : 'toggle'} onClick={() => setWithCoat(on => !on)}>
            + {coat.name}
          </button>
        </p>
      )}
      <div className="wardrobe-chips">
        {chips.map(c => {
          const ids = dressed(c.garmentIds)
          return (
            <button key={c.key} type="button" className="wardrobe-chip" title={c.reason === 'saved' ? 'A saved outfit' : 'You wear this often'} onClick={() => tap(newWear(dayKey, ids))}>
              <Collage ids={ids} byId={byId} />
              <span className="wardrobe-chip-label">{c.label}</span>
            </button>
          )
        })}
        <button type="button" className="wardrobe-chip pick" onClick={() => onOpen({ tab: 'outfit', date: dayKey })}>
          Pick…
        </button>
      </div>
      {forgot}
    </section>
  )
}
