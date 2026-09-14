import { useEffect, useMemo, useRef, useState } from 'react'
import { haptic } from '../../native'
import { LOOK_NOTE_MAX, type Garment, type Outfit, type Wear } from '../../types'
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
  /** The clock "before noon" is read from; the tests hand one in. */
  now?: Date
  /** Today's forecast; by default the one the briefing cached (the tests hand one in). */
  forecast?: Forecast | null
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
 * today has a look it is one line with Change, and its note. When the forecast
 * is cold or wet, it offers a coat. Hidden until the wardrobe can dress you (a
 * top and a bottom, or a one-piece), so nobody without one is asked. The one
 * tap is the only thing in the wardrobe that buzzes.
 */
export function WardrobeCard({ garments, outfits, wears, dayKey, onLog, onOpen, now = new Date(), forecast: given }: Props) {
  const byId = useMemo(() => liveById(garments), [garments])
  const ix = useMemo(() => wearIndex(wears, dayKey), [wears, dayKey])
  const chips = useMemo(() => todaySuggestions(ix, outfits, byId), [ix, outfits, byId])
  const cached = useCachedForecast()
  const [withCoat, setWithCoat] = useState(false)
  if (!canDress(garments)) return null

  const forecast = given !== undefined ? given : cached
  const need = weatherNeed(forecast)
  const coat = need ? outerwearFor(garments, ix, need) : undefined
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

  const today = ix.looks.get(dayKey)
  if (today?.length) {
    const look = today[today.length - 1]
    return (
      <section className="chart-card wardrobe-card logged">
        <div className="wardrobe-card-look">
          {thumbs(look.garmentIds)}
          <p className="wardrobe-card-line">
            <span className="muted">Wearing</span> {outfitLabel(look.garmentIds, byId)}
          </p>
          <button type="button" className="btn subtle" onClick={() => onOpen({ date: dayKey })}>
            Change
          </button>
        </div>
        {noteOn(look)}
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
      </section>
    )
  }

  const yesterday = forgotYesterday(ix, now.getHours())
  // with the coat asked for, each look takes it, unless it has outerwear of its own
  const dressed = (ids: string[]) => (withCoat && coat && !hasOuterwear(ids, byId) ? [...ids, coat.id] : ids)
  return (
    <section className="chart-card wardrobe-card">
      <header className="chart-head">
        <div>
          <h3>What are you wearing?</h3>
          <p className="chart-sub">Tap one to log it, or pick</p>
        </div>
      </header>
      {coat && sky && (
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
      {yesterday && (
        <button type="button" className="wardrobe-forgot" onClick={() => onOpen({ date: yesterday })}>
          Forgot yesterday? Log it
        </button>
      )}
    </section>
  )
}
