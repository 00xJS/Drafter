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

/**
 * A piece's picture: the 360px thumbnail (or, on the piece sheet, the 1200px
 * photo) from the media store, shown whole — contain, never cropped. Until it
 * has loaded, or while it has not reached this device yet, a tile tinted with
 * the piece's own colour carries its type instead.
 */
export function GarmentPhoto({ garment, size = 'thumb', className, alt = '' }: { garment: Garment; size?: 'thumb' | 'photo'; className?: string; alt?: string }) {
  const id = size === 'photo' ? (garment.photoId ?? garment.thumbId) : (garment.thumbId ?? garment.photoId)
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
    <span className={className ? `garment-photo ${className}` : 'garment-photo'} style={tint}>
      {url ? <img src={url} alt={alt} loading="lazy" decoding="async" /> : <span className="garment-photo-type">{GARMENT_TYPE_META[garment.type].label}</span>}
    </span>
  )
}

const firstOf = (pieces: readonly Garment[], type: GarmentType) => pieces.find(g => g.type === type)

/**
 * A look drawn as one tile: the top over the bottom, or the one-piece filling
 * it, with outerwear and shoes as corner badges. A piece no longer known
 * leaves its half empty.
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
