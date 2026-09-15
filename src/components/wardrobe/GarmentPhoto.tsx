import { useEffect, useState } from 'react'
import { mediaURL, peekMediaURL } from '../../media'
import { GARMENT_TYPE_META, type Garment, type GarmentType } from '../../types'
import { Icon } from '../Icon'

/**
 * A favourite's star, said as well as drawn: a badge in a card's corner, or
 * `inline` before a name. It sits on the card's own surface, never on the
 * photo's colours, so it reads the same over any picture and in either theme.
 */
export function FavouriteMark({ inline }: { inline?: boolean }) {
  return (
    <span className={inline ? 'fav-mark inline' : 'fav-mark'} title="Favourite">
      <Icon name="star" size={inline ? 11 : 12} filled />
      <span className="wardrobe-sr">Favourite: </span>
    </span>
  )
}

/** A side of a piece: its front, or the photo of its back. */
export type Side = 'front' | 'back'

/** Whether a piece has a photo of its back. */
export const hasBack = (g: Garment): boolean => !!(g.backPhotoId || g.backThumbId)

/**
 * The side a piece is shown by, wherever it is drawn: its front, or its back
 * when Show the back first is on and it has one. At card size or larger the
 * other side is the inset (GarmentView, and the composer's cards); a small
 * thumbnail — a collage, Today, Stats, Search, the Calendar — shows this side
 * alone. Every caller reads it here, so none disagrees.
 */
export const mainSide = (g: Garment): Side => (g.showBack && hasBack(g) ? 'back' : 'front')

export const otherSide = (s: Side): Side => (s === 'back' ? 'front' : 'back')

/** The inset's name, for the side it would bring up: "Show the back" or "Show the front". */
export const flipLabel = (s: Side): string => (s === 'back' ? 'Show the back' : 'Show the front')

/**
 * A piece's picture: one side of it — by default the side it is shown by —
 * as the 360px thumbnail (or, on the piece sheet, the 1200px photo) from the
 * media store, shown whole: contain, never cropped. Until it has loaded, or
 * while it has not reached this device yet, a tile tinted with the piece's
 * own colour carries its type instead.
 */
export function GarmentPhoto({
  garment,
  side,
  size = 'thumb',
  className,
  alt = '',
}: {
  garment: Garment
  side?: Side
  size?: 'thumb' | 'photo'
  className?: string
  alt?: string
}) {
  const shown = side ?? mainSide(garment)
  const [photo, thumb] = shown === 'back' ? [garment.backPhotoId, garment.backThumbId] : [garment.photoId, garment.thumbId]
  const id = size === 'photo' ? (photo ?? thumb) : (thumb ?? photo)
  const [loaded, setLoaded] = useState<{ id?: string; url: string | null }>(() => ({ id, url: id ? peekMediaURL(id) : null }))
  useEffect(() => {
    if (!id) return
    let live = true
    void mediaURL(id).then(
      url => {
        if (live) setLoaded({ id, url })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [id])
  const url = loaded.id === id ? loaded.url : id ? peekMediaURL(id) : null
  // a piece's colour is data, applied inline the way a place's is
  const tint = !url && garment.color ? { background: `color-mix(in srgb, ${garment.color} 35%, var(--surface-2))` } : undefined
  return (
    <span className={className ? `garment-photo ${className}` : 'garment-photo'} style={tint} data-side={shown === 'back' ? 'back' : undefined}>
      {url ? <img src={url} alt={alt} loading="lazy" decoding="async" /> : <span className="garment-photo-type">{GARMENT_TYPE_META[garment.type].label}</span>}
    </span>
  )
}

/**
 * A piece's other side, small in its photo's corner: it says there is another
 * view. With `onFlip` it is a button that swaps the two — for the view only,
 * nothing is saved — named for the side it would bring up; without, a mark,
 * left out for a screen reader (the tile it sits in says so in words).
 */
export function GarmentInset({ garment, side, onFlip, tabIndex, className }: { garment: Garment; side: Side; onFlip?(): void; tabIndex?: number; className?: string }) {
  const cls = className ? `garment-inset ${className}` : 'garment-inset'
  const picture = <GarmentPhoto garment={garment} side={side} />
  return onFlip ? (
    <button type="button" className={`${cls} flip`} aria-label={flipLabel(side)} title={flipLabel(side)} tabIndex={tabIndex} onClick={onFlip}>
      {picture}
    </button>
  ) : (
    <span className={cls} aria-hidden="true">
      {picture}
    </span>
  )
}

/**
 * A piece at card size or larger: the side it is shown by and, when it has a
 * back photo, the other side as an inset in the corner. With `flip` the inset
 * swaps the two while this is on screen, with a quick fade (none with reduced
 * motion) in boxes that never move; without, it only marks the other view.
 */
export function GarmentView({ garment, size, alt = '', flip, className }: { garment: Garment; size?: 'thumb' | 'photo'; alt?: string; flip?: boolean; className?: string }) {
  const [swapped, setSwapped] = useState(false)
  const back = hasBack(garment)
  const main = mainSide(garment)
  const shown = back && swapped ? otherSide(main) : main
  return (
    <span className={className ? `garment-view ${className}` : 'garment-view'}>
      <GarmentPhoto key={shown} garment={garment} side={shown} size={size} alt={alt && shown === 'back' ? `${alt}, the back` : alt} className={flip ? 'flippable' : undefined} />
      {back && <GarmentInset garment={garment} side={otherSide(shown)} onFlip={flip ? () => setSwapped(s => !s) : undefined} />}
    </span>
  )
}

const firstOf = (pieces: readonly Garment[], type: GarmentType) => pieces.find(g => g.type === type)

/**
 * A look drawn as one tile: the top over the bottom, or the one-piece filling
 * it, with outerwear and shoes as corner badges. A piece no longer known
 * leaves its half empty. Each piece is its main side alone.
 */
export function Collage({ ids, byId, className }: { ids: readonly string[]; byId: ReadonlyMap<string, Garment>; className?: string }) {
  const pieces = ids.map(id => byId.get(id)).filter((g): g is Garment => !!g)
  const one = firstOf(pieces, 'onepiece')
  const outer = firstOf(pieces, 'outerwear')
  const shoes = firstOf(pieces, 'shoes')
  const half = (g: Garment | undefined) => (g ? <GarmentPhoto garment={g} className="collage-half" /> : <span className="garment-photo collage-half" />)
  return (
    <span className={className ? `collage ${className}` : 'collage'} aria-hidden="true">
      {one ? (
        <GarmentPhoto garment={one} className="collage-full" />
      ) : (
        <>
          {half(firstOf(pieces, 'top'))}
          {half(firstOf(pieces, 'bottom'))}
        </>
      )}
      {outer && <GarmentPhoto garment={outer} className="collage-badge outer" />}
      {shoes && <GarmentPhoto garment={shoes} className="collage-badge shoes" />}
    </span>
  )
}
