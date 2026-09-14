import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Trash } from '../components/Trash'
import { KNOWN_KINDS, migrateStored, sanitizeGarment, sanitizeItem, sanitizeOutfit, sanitizeWear } from '../schema'
import { recordLabel } from '../syncengine'
import { Garment, Item, Outfit, Wear } from '../types'

// The wardrobe's three kinds as the store meets them: what the sanitizers keep
// and repair, how a synced row is routed, and what Trash and the sync toasts
// call each one. The rules and figures are in wardrobe.test.ts.

const T0 = '2026-09-13T08:00:00.000Z'
const USER = '00000000-0000-0000-0000-00000000000a'
const PHOTO = '7f3c9a10-1b2c-4d3e-8f40-5a6b7c8d9e0f'

const garment: Garment = { kind: 'garment', id: 'g1', name: 'White tee', type: 'top', photoId: `personal/${USER}/${PHOTO}`, thumbId: PHOTO, color: '#f5f5f0', createdAt: T0, updatedAt: T0 }
const outfit: Outfit = { kind: 'outfit', id: 'o1', name: 'Friday smart', garmentIds: ['g1', 'g2'], createdAt: T0, updatedAt: T0 }
const wear: Wear = { kind: 'wear', id: 'wear~2026-09-13~a1b2c3d4e5', date: '2026-09-13', garmentIds: ['g1'], createdAt: T0, updatedAt: T0 }

describe('sanitizeGarment', () => {
  const base = { kind: 'garment', id: 'g1', name: 'White tee', type: 'top', createdAt: T0, updatedAt: T0 }

  it('passes a piece through, its colour lowercased and its notes trimmed', () => {
    expect(sanitizeGarment({ ...garment, color: '#F5F5F0', notes: '  soft cotton ' })).toEqual({ ...garment, notes: 'soft cotton' })
  })

  it('reads an unknown type as an accessory, which is never an outfit’s core', () => {
    expect(sanitizeGarment({ ...base, type: 'cape' })?.type).toBe('accessory')
    expect(sanitizeGarment({ ...base, type: undefined })?.type).toBe('accessory')
    expect(sanitizeGarment({ ...base, type: 'onepiece' })?.type).toBe('onepiece')
  })

  it('names a live piece after its type when it has no name, and leaves a tombstone blank', () => {
    expect(sanitizeGarment({ ...base, name: '   ', type: 'bottom' })?.name).toBe('Bottom')
    expect(sanitizeGarment({ ...base, name: undefined, type: 'onepiece' })?.name).toBe('One-piece')
    expect(sanitizeGarment({ kind: 'garment', id: 'g1', deletedAt: T0, purged: true })?.name).toBe('')
  })

  it('keeps a photo only as a media-store id: a uid, or personal/<user id>/<uid>', () => {
    const photo = (photoId: unknown) => sanitizeGarment({ ...base, photoId })?.photoId
    expect(photo(PHOTO)).toBe(PHOTO)
    expect(photo(`personal/${USER}/${PHOTO}`)).toBe(`personal/${USER}/${PHOTO}`)
    // uid() where crypto.randomUUID is missing: base 36, no dashes
    expect(photo('lq2x8k1m9z0abcd')).toBe('lq2x8k1m9z0abcd')
    for (const bad of ['backups/x/y.json', `backups/${USER}/2026-09-13.json`, '../x', 'personal/x/y', `personal/${USER}/../x`, `personal/${USER}/`, 'short', '', 42, null]) {
      expect(photo(bad), String(bad)).toBeUndefined()
    }
    expect(sanitizeGarment({ ...base, thumbId: '../x' })?.thumbId).toBeUndefined()
  })

  it('takes a colour only as #rrggbb', () => {
    expect(sanitizeGarment({ ...base, color: ' #1F2A44 ' })?.color).toBe('#1f2a44')
    for (const bad of ['#fff', 'navy', 'rgb(0, 0, 0)', '#1f2a44ff', 12]) expect(sanitizeGarment({ ...base, color: bad })?.color, String(bad)).toBeUndefined()
  })

  it('caps notes at 500 characters and a name at 80, and keeps archivedAt', () => {
    const g = sanitizeGarment({ ...base, name: 'x'.repeat(100), notes: `  ${'n'.repeat(600)}  `, archivedAt: '2026-09-01T10:00:00Z' })!
    expect(g.notes).toBe('n'.repeat(500))
    expect(g.name).toBe('x'.repeat(80))
    expect(g.archivedAt).toBe('2026-09-01T10:00:00.000Z')
    expect(sanitizeGarment(base)?.archivedAt).toBeUndefined()
  })

  it('needs an id', () => {
    expect(sanitizeGarment({ ...base, id: undefined })).toBeNull()
    expect(sanitizeGarment(null)).toBeNull()
    expect(sanitizeGarment('garment')).toBeNull()
  })
})

describe('sanitizeOutfit', () => {
  const base = { kind: 'outfit', id: 'o1', garmentIds: ['g1', 'g2'], createdAt: T0, updatedAt: T0 }

  it('keeps unique, trimmed piece ids in their order, twelve at most', () => {
    expect(sanitizeOutfit({ ...base, garmentIds: [' g2 ', 'g1', 'g2', '', 7, null, 'g3'] })?.garmentIds).toEqual(['g2', 'g1', 'g3'])
    const many = Array.from({ length: 20 }, (_, i) => `g${i}`)
    expect(sanitizeOutfit({ ...base, garmentIds: many })?.garmentIds).toEqual(many.slice(0, 12))
  })

  it('has a name only when it was given one', () => {
    expect(sanitizeOutfit(base)?.name).toBeUndefined()
    expect(sanitizeOutfit({ ...base, name: '   ' })?.name).toBeUndefined()
    expect(sanitizeOutfit({ ...base, name: '  Friday smart ' })?.name).toBe('Friday smart')
  })

  it('refuses a live outfit with no pieces, and keeps a tombstone that has none', () => {
    expect(sanitizeOutfit({ ...base, garmentIds: [] })).toBeNull()
    expect(sanitizeOutfit({ ...base, garmentIds: 'g1' })).toBeNull()
    expect(sanitizeOutfit({ kind: 'outfit', id: 'o1', garmentIds: [], deletedAt: T0, purged: true })).toMatchObject({ id: 'o1', garmentIds: [], deletedAt: T0, purged: true })
  })
})

describe('sanitizeWear', () => {
  const base = { kind: 'wear', id: 'wear~2026-09-13~a1b2c3d4e5', date: '2026-09-13', garmentIds: ['g1'], createdAt: T0, updatedAt: T0 }

  it('keeps a look on its local day', () => {
    expect(sanitizeWear(base)).toEqual(wear)
  })

  it('takes the day only as a day key: an instant is refused, never read as its UTC date', () => {
    // 23:30 UTC on the 13th is already the 14th in New Zealand: which day would it be?
    expect(sanitizeWear({ ...base, id: 'w1', date: '2026-09-13T23:30:00Z' })).toBeNull()
    expect(sanitizeWear({ ...base, id: 'w1', date: '2026-02-30' })).toBeNull()
    // with the day in its id, the id's day stands
    expect(sanitizeWear({ ...base, date: '2026-09-13T23:30:00Z' })?.date).toBe('2026-09-13')
  })

  it('takes a tombstone’s day from its id', () => {
    expect(sanitizeWear({ kind: 'wear', id: 'wear~2026-09-07~abcd', deletedAt: T0, purged: true })).toMatchObject({ date: '2026-09-07', garmentIds: [], deletedAt: T0, purged: true })
  })

  it('keeps an empty live look (coerce, don’t reject); it counts as nothing', () => {
    expect(sanitizeWear({ ...base, garmentIds: undefined })).toMatchObject({ id: base.id, garmentIds: [] })
    expect(sanitizeWear({ ...base, garmentIds: ['g1', 'g1', ' g2 '] })?.garmentIds).toEqual(['g1', 'g2'])
  })

  it('needs an id and a day', () => {
    expect(sanitizeWear({ ...base, id: undefined })).toBeNull()
    expect(sanitizeWear({ kind: 'wear', id: 'w1', garmentIds: ['g1'] })).toBeNull()
  })
})

describe('a synced or imported row', () => {
  it('goes to its own sanitizer, not a blank task, and is not dropped as an unknown kind', () => {
    for (const kind of ['garment', 'outfit', 'wear']) expect(KNOWN_KINDS.has(kind), kind).toBe(true)
    expect(sanitizeItem({ kind: 'garment', id: 'g1', name: 'Tee', type: 'cape' })).toMatchObject({ kind: 'garment', type: 'accessory' })
    expect(sanitizeItem({ kind: 'outfit', id: 'o1', garmentIds: ['g1'] })).toMatchObject({ kind: 'outfit', garmentIds: ['g1'] })
    expect(sanitizeItem({ kind: 'wear', id: 'wear~2026-09-13~a1', garmentIds: ['g1'] })).toMatchObject({ kind: 'wear', date: '2026-09-13' })
    expect(sanitizeItem({ kind: 'wear', id: 'w1', date: '2026-09-13T23:30:00Z' })).toBeNull()
  })

  it('round-trips through a JSON export', () => {
    const items: Item[] = [garment, outfit, wear, { ...garment, id: 'g2', archivedAt: T0 }]
    expect(migrateStored(JSON.parse(JSON.stringify({ version: 3, items })))).toEqual(items)
  })
})

describe('what Trash and the sync toasts call them', () => {
  it('recordLabel', () => {
    expect(recordLabel(wear)).toBe('Outfit worn 2026-09-13')
    expect(recordLabel({ ...wear, date: '' })).toBe('Outfit worn')
    expect(recordLabel(outfit)).toBe('Friday smart')
    expect(recordLabel({ ...outfit, name: undefined })).toBe('An outfit')
    expect(recordLabel(garment)).toBe('White tee')
    expect(recordLabel({ ...garment, name: '' })).toBe('Untitled piece')
  })

  it('Trash lists each under its own label, with a title', () => {
    const binned = <T extends Item>(x: T): T => ({ ...x, deletedAt: '2026-09-13T10:00:00.000Z' })
    const items: Item[] = [
      binned(garment),
      binned({ ...garment, id: 'g-blank', name: '' }),
      binned(outfit),
      binned({ ...outfit, id: 'o-unnamed', name: undefined }),
      binned(wear),
      binned({ ...wear, id: 'wear~2026-09-12~b1', date: '2026-09-12', garmentIds: ['g1', 'g2', 'g3'] }),
      // a purged tombstone has nothing to restore and is not listed
      binned({ ...garment, id: 'g-purged', name: '', purged: true }),
    ]
    const html = renderToStaticMarkup(createElement(Trash, { items, projectMap: new Map(), onRestore: () => {}, onPurge: () => {}, onClose: () => {} })).replace(/<!-- -->/g, '')
    expect(html).toContain('<small class="muted">Clothing</small> White tee')
    expect(html).toContain('<small class="muted">Clothing</small> Untitled piece')
    expect(html).toContain('<small class="muted">Outfit</small> Friday smart')
    expect(html).toContain('<small class="muted">Outfit</small> 2 pieces')
    expect(html).toContain('<small class="muted">Outfit worn</small> 2026-09-13 · 1 piece')
    expect(html).toContain('<small class="muted">Outfit worn</small> 2026-09-12 · 3 pieces')
    expect(html.match(/class="trash-row"/g)).toHaveLength(6)
  })
})
