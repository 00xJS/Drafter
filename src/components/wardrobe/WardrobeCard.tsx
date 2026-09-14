import { useMemo } from 'react'
import { haptic } from '../../native'
import type { Garment, Outfit, Wear } from '../../types'
import { canDress, forgotYesterday, liveById, newWear, orderPieces, outfitLabel, todaySuggestions, wearIndex } from '../../wardrobe'
import type { WardrobeOpen } from '../planner/useNavigation'
import { Collage, GarmentPhoto } from './GarmentPhoto'

interface Props {
  garments: Garment[]
  outfits: Outfit[]
  wears: Wear[]
  /** Today, as a local day key. */
  dayKey: string
  /** One tap: the look to save (the shell saves it and offers Undo). */
  onLog(w: Wear): void
  /** Pick…, Change and Forgot yesterday: Home → Wardrobe on a day. */
  onOpen(o: WardrobeOpen): void
  /** The clock "before noon" is read from; the tests hand one in. */
  now?: Date
}

/**
 * Today's "What are you wearing?": up to three looks — saved outfits and what
 * you wear most — each logged with one tap, and Pick… for anything else. Once
 * today has a look it is one line with Change. Hidden until the wardrobe can
 * dress you (a top and a bottom, or a one-piece), so nobody without one is
 * asked. The one tap is the only thing in the wardrobe that buzzes.
 */
export function WardrobeCard({ garments, outfits, wears, dayKey, onLog, onOpen, now = new Date() }: Props) {
  const byId = useMemo(() => liveById(garments), [garments])
  const ix = useMemo(() => wearIndex(wears, dayKey), [wears, dayKey])
  const chips = useMemo(() => todaySuggestions(ix, outfits, byId), [ix, outfits, byId])
  if (!canDress(garments)) return null

  const today = ix.looks.get(dayKey)
  if (today?.length) {
    const look = today[today.length - 1]
    return (
      <section className="chart-card wardrobe-card logged">
        <span className="wardrobe-card-thumbs" aria-hidden="true">
          {orderPieces(look.garmentIds, byId)
            .slice(0, 3)
            .map(id => (
              <GarmentPhoto key={id} garment={byId.get(id)!} />
            ))}
        </span>
        <p className="wardrobe-card-line">
          <span className="muted">Wearing</span> {outfitLabel(look.garmentIds, byId)}
        </p>
        <button type="button" className="btn subtle" onClick={() => onOpen({ date: dayKey })}>
          Change
        </button>
      </section>
    )
  }

  const yesterday = forgotYesterday(ix, now.getHours())
  return (
    <section className="chart-card wardrobe-card">
      <header className="chart-head">
        <div>
          <h3>What are you wearing?</h3>
          <p className="chart-sub">Tap one to log it, or pick</p>
        </div>
      </header>
      <div className="wardrobe-chips">
        {chips.map(c => (
          <button
            key={c.key}
            type="button"
            className="wardrobe-chip"
            title={c.reason === 'saved' ? 'A saved outfit' : 'You wear this often'}
            onClick={() => {
              void haptic('light')
              onLog(newWear(dayKey, c.garmentIds))
            }}
          >
            <Collage ids={c.garmentIds} byId={byId} />
            <span className="wardrobe-chip-label">{c.label}</span>
          </button>
        ))}
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
