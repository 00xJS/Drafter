import { useMemo, useRef, useState } from 'react'
import { OCCASION_META, type Garment, type Outfit } from '../../types'
import { outfitLabel, outfitLine, outfitOccasion, savedOrder, unwearable, type WearIndex } from '../../wardrobe'
import { ConfirmButton } from '../ConfirmButton'
import { Icon } from '../Icon'
import { Modal, ModalHead } from '../Modal'
import { Collage, FavouriteMark } from './GarmentPhoto'

interface Props {
  outfits: Outfit[]
  byId: ReadonlyMap<string, Garment>
  ix: WearIndex
  /** Put it on the look card. */
  onLoad(o: Outfit): void
  onWear(o: Outfit): void
  onRename(o: Outfit, name: string): void
  onFavourite(o: Outfit, on: boolean): void
  onDelete(o: Outfit): void
}

/**
 * The saved outfits on the Outfit board, each a look drawn small, the
 * favourites and then the most worn lately first: a tap puts one on the card
 * — whatever the day is dressed for — and "…" wears it today, stars it,
 * renames it or deletes it. One whose pieces are for work, or for days off,
 * says so (outfitOccasion).
 */
export function SavedOutfits({ outfits, byId, ix, onLoad, onWear, onRename, onFavourite, onDelete }: Props) {
  const list = useMemo(() => savedOrder(outfits, ix, byId), [outfits, ix, byId])
  const [menuId, setMenuId] = useState<string | null>(null)
  const menu = list.find(o => o.id === menuId)
  if (list.length === 0) return null
  const label = (o: Outfit) => o.name || outfitLabel(o.garmentIds, byId)
  return (
    <section className="saved-outfits">
      <h3 className="wardrobe-heading">Saved outfits ({list.length})</h3>
      <ul className="saved-strip">
        {list.map(o => {
          const occasion = outfitOccasion(o.garmentIds, byId)
          return (
          <li key={o.id} className="saved-tile">
            <button type="button" className="saved-load" title="Put it on the card" onClick={() => onLoad(o)}>
              <Collage ids={o.garmentIds} byId={byId} />
              <span className="saved-name">
                {o.favourite && <FavouriteMark inline />}
                {label(o)}
              </span>
              <span className="saved-line">{outfitLine(o, ix, byId)}</span>
              {occasion && <span className={`badge occasion-badge ${occasion}`}>{OCCASION_META[occasion].label}</span>}
            </button>
            <button type="button" className="saved-more" aria-label={`More for ${label(o)}`} onClick={() => setMenuId(o.id)}>
              <span aria-hidden="true">…</span>
            </button>
          </li>
          )
        })}
      </ul>
      {menu && (
        <OutfitMenu
          key={menu.id}
          outfit={menu}
          title={label(menu)}
          placeholder={outfitLabel(menu.garmentIds, byId)}
          why={unwearable(menu.garmentIds, byId)}
          onWear={onWear}
          onRename={onRename}
          onFavourite={onFavourite}
          onDelete={onDelete}
          onClose={() => setMenuId(null)}
        />
      )}
    </section>
  )
}

/**
 * One saved outfit's "…": rename it, star it, delete it, or wear it today —
 * logged as a Today chip logs, so only when every piece is in use and it has a
 * core; otherwise the menu says why.
 */
export function OutfitMenu({
  outfit,
  title,
  placeholder,
  why,
  onWear,
  onRename,
  onFavourite,
  onDelete,
  onClose,
}: {
  outfit: Outfit
  title: string
  placeholder: string
  /** Why it cannot be worn as it is ("Old band tee is retired"); null when it can. */
  why: string | null
  onWear(o: Outfit): void
  onRename(o: Outfit, name: string): void
  onFavourite(o: Outfit, on: boolean): void
  onDelete(o: Outfit): void
  onClose(): void
}) {
  const [name, setName] = useState(outfit.name ?? '')
  // what was last written, so Enter and the blur after it do not write twice
  const saved = useRef(outfit.name ?? '')
  const commit = () => {
    if (name.trim() === saved.current) return
    saved.current = name.trim()
    onRename(outfit, name)
  }
  return (
    <Modal
      onClose={() => {
        commit()
        onClose()
      }}
      className="modal narrow"
    >
      <ModalHead title={title} />
      <div className="modal-body">
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            placeholder={placeholder}
            maxLength={80}
            onChange={e => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              }
            }}
          />
        </label>
        <button
          type="button"
          aria-pressed={!!outfit.favourite}
          className={outfit.favourite ? 'toggle on outfit-fav' : 'toggle outfit-fav'}
          onClick={() => onFavourite(outfit, !outfit.favourite)}
        >
          <Icon name="star" size={14} filled={!!outfit.favourite} /> Favourite
        </button>
        {why && <p className="outfit-why">{why}</p>}
      </div>
      <footer className="modal-foot">
        <ConfirmButton
          className="btn subtle danger"
          onConfirm={() => {
            onDelete(outfit)
            onClose()
          }}
        >
          Delete
        </ConfirmButton>
        <span className="spacer" />
        <button
          type="button"
          className="btn primary"
          disabled={!!why}
          onClick={() => {
            commit()
            onWear(outfit)
            onClose()
          }}
        >
          Wear today
        </button>
      </footer>
    </Modal>
  )
}
