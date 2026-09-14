import { useMemo, useState } from 'react'
import { GARMENT_TYPES, GARMENT_TYPE_META, type Garment, type GarmentType } from '../../types'
import { CLOTHES_SORTS, clothesOrder, wornShort, type ClothesSort, type WearIndex } from '../../wardrobe'
import { Icon } from '../Icon'
import { GarmentPhoto } from './GarmentPhoto'

interface Props {
  garments: Garment[]
  ix: WearIndex
  /** The piece sheet, to add one (of the type filtered to, if any). */
  onAdd(type?: GarmentType): void
  onOpen(id: string): void
}

function Tile({ garment, ix, onOpen }: { garment: Garment; ix: WearIndex; onOpen(id: string): void }) {
  return (
    <li>
      <button type="button" className="clothes-tile" onClick={() => onOpen(garment.id)}>
        <GarmentPhoto garment={garment} />
        <span className="clothes-name">{garment.name}</span>
        <span className="clothes-worn">{wornShort(ix, garment.id)}</span>
      </button>
    </li>
  )
}

/**
 * Every piece: a filter by type, a sort (the ones rested longest first unless
 * you choose otherwise), a tile to add one, and the retired ones kept apart at
 * the foot, their history intact.
 */
export function Clothes({ garments, ix, onAdd, onOpen }: Props) {
  const [filter, setFilter] = useState<GarmentType | 'all'>('all')
  const [sort, setSort] = useState<ClothesSort>('rest')
  const inUse = useMemo(() => garments.filter(g => !g.deletedAt && !g.archivedAt), [garments])
  const retiredOnes = useMemo(() => clothesOrder(garments.filter(g => !!g.archivedAt), ix, 'name'), [garments, ix])
  const counts = useMemo(() => {
    const n = new Map<GarmentType, number>()
    for (const g of inUse) n.set(g.type, (n.get(g.type) ?? 0) + 1)
    return n
  }, [inUse])
  // a filter whose last piece went (retired, deleted, retyped) falls back to All
  const type = filter !== 'all' && counts.get(filter) ? filter : 'all'
  const shown = useMemo(() => clothesOrder(type === 'all' ? inUse : inUse.filter(g => g.type === type), ix, sort), [inUse, type, ix, sort])

  return (
    <div className="clothes">
      <div className="clothes-tools">
        <div className="clothes-filters" role="group" aria-label="Show">
          <button type="button" aria-pressed={type === 'all'} className={type === 'all' ? 'toggle on' : 'toggle'} onClick={() => setFilter('all')}>
            All <span className="count">{inUse.length}</span>
          </button>
          {GARMENT_TYPES.filter(t => counts.get(t)).map(t => (
            <button key={t} type="button" aria-pressed={type === t} className={type === t ? 'toggle on' : 'toggle'} onClick={() => setFilter(t)}>
              {GARMENT_TYPE_META[t].plural} <span className="count">{counts.get(t)}</span>
            </button>
          ))}
        </div>
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
      </div>
      {inUse.length === 0 && <p className="empty">Nothing here yet. Add a piece — the photo is optional.</p>}
      <ul className="clothes-grid">
        <li>
          <button type="button" className="clothes-tile add" onClick={() => onAdd(type === 'all' ? undefined : type)}>
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
