import { useMemo, useState } from 'react'
import { GARMENT_TYPES, GARMENT_TYPE_META, SEASONS, SEASON_META, type Garment, type GarmentType, type Season } from '../../types'
import { CLOTHES_SORTS, clothesMatch, clothesOrder, tagsOf, wornShort, type ClothesShow, type ClothesSort, type WearIndex } from '../../wardrobe'
import { Icon } from '../Icon'
import { FavouriteMark, GarmentView, hasBack } from './GarmentPhoto'

interface Props {
  garments: Garment[]
  ix: WearIndex
  /** The piece sheet, to add one (of the type filtered to, if any). */
  onAdd(type?: GarmentType): void
  onOpen(id: string): void
}

/** A tile opens its piece: a back photo is marked in the corner, not a control of its own, and said in words. */
function Tile({ garment, ix, onOpen }: { garment: Garment; ix: WearIndex; onOpen(id: string): void }) {
  return (
    <li>
      <button type="button" className="clothes-tile" onClick={() => onOpen(garment.id)}>
        {garment.favourite && <FavouriteMark />}
        <GarmentView garment={garment} />
        <span className="clothes-name">{garment.name}</span>
        {hasBack(garment) && <span className="wardrobe-sr"> (with a back photo)</span>}
        <span className="clothes-worn">{wornShort(ix, garment.id)}</span>
      </button>
    </li>
  )
}

/**
 * Every piece: a filter by type or to the favourites, a season and a tag to
 * narrow it, a sort (the ones rested longest first unless you choose
 * otherwise), a tile to add one, and the retired ones kept apart at the foot,
 * their history intact.
 */
export function Clothes({ garments, ix, onAdd, onOpen }: Props) {
  const [filter, setFilter] = useState<ClothesShow>('all')
  const [season, setSeason] = useState<Season | ''>('')
  const [tag, setTag] = useState<string | null>(null)
  const [sort, setSort] = useState<ClothesSort>('rest')
  const inUse = useMemo(() => garments.filter(g => !g.deletedAt && !g.archivedAt), [garments])
  const retiredOnes = useMemo(() => clothesOrder(garments.filter(g => !!g.archivedAt), ix, 'name'), [garments, ix])
  const counts = useMemo(() => {
    const n = new Map<GarmentType, number>()
    for (const g of inUse) n.set(g.type, (n.get(g.type) ?? 0) + 1)
    return n
  }, [inUse])
  const favourites = useMemo(() => inUse.filter(g => g.favourite).length, [inUse])
  const tags = useMemo(() => tagsOf(inUse), [inUse])
  // a filter whose last piece went (retired, deleted, retyped, unstarred, untagged) falls back to All
  const show: ClothesShow = filter === 'favourites' ? (favourites > 0 ? filter : 'all') : filter !== 'all' && counts.get(filter) ? filter : 'all'
  const tagOn = tag && tags.some(t => t.tag === tag) ? tag : null
  const shown = useMemo(() => clothesOrder(inUse.filter(g => clothesMatch(g, { show, season: season || null, tag: tagOn })), ix, sort), [inUse, show, season, tagOn, ix, sort])

  return (
    <div className="clothes">
      <div className="clothes-tools">
        <div className="clothes-filters" role="group" aria-label="Show">
          <button type="button" aria-pressed={show === 'all'} className={show === 'all' ? 'toggle on' : 'toggle'} onClick={() => setFilter('all')}>
            All <span className="count">{inUse.length}</span>
          </button>
          {favourites > 0 && (
            <button type="button" aria-pressed={show === 'favourites'} className={show === 'favourites' ? 'toggle on' : 'toggle'} onClick={() => setFilter('favourites')}>
              <Icon name="star" size={12} filled /> Favourites <span className="count">{favourites}</span>
            </button>
          )}
          {GARMENT_TYPES.filter(t => counts.get(t)).map(t => (
            <button key={t} type="button" aria-pressed={show === t} className={show === t ? 'toggle on' : 'toggle'} onClick={() => setFilter(t)}>
              {GARMENT_TYPE_META[t].plural} <span className="count">{counts.get(t)}</span>
            </button>
          ))}
        </div>
        {/* a piece marked for no season is for any, so it stays under every one */}
        <select className="clothes-season" aria-label="Season" value={season} onChange={e => setSeason(e.target.value as Season | '')}>
          <option value="">Any season</option>
          {SEASONS.map(s => (
            <option key={s} value={s}>
              {SEASON_META[s].label}
            </option>
          ))}
        </select>
        <label className="clothes-sort">
          <span>Sort</span>
          <select value={sort} onChange={e => setSort(e.target.value as ClothesSort)}>
            {CLOTHES_SORTS.map(s => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {tags.length > 0 && (
          <div className="clothes-filters clothes-tags" role="group" aria-label="Tags">
            {tags.map(t => (
              <button key={t.tag} type="button" aria-pressed={tagOn === t.tag} className={tagOn === t.tag ? 'toggle on' : 'toggle'} onClick={() => setTag(tagOn === t.tag ? null : t.tag)}>
                {t.tag} <span className="count">{t.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {inUse.length === 0 && <p className="empty">Nothing here yet. Add a piece — the photo is optional.</p>}
      {inUse.length > 0 && shown.length === 0 && <p className="empty">Nothing in use fits these filters.</p>}
      <ul className="clothes-grid">
        <li>
          <button type="button" className="clothes-tile add" onClick={() => onAdd(show === 'all' || show === 'favourites' ? undefined : show)}>
            <Icon name="plus" size={22} />
            <span>Add</span>
          </button>
        </li>
        {shown.map(g => (
          <Tile key={g.id} garment={g} ix={ix} onOpen={onOpen} />
        ))}
      </ul>
      {retiredOnes.length > 0 && (
        <details className="clothes-retired">
          <summary>Retired ({retiredOnes.length})</summary>
          <ul className="clothes-grid">
            {retiredOnes.map(g => (
              <Tile key={g.id} garment={g} ix={ix} onOpen={onOpen} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
