import { GARMENT_TYPES, type Garment, type GarmentType, type Wear } from '../../types'
import { coreKey, notInUse } from '../../wardrobe'

// The composer's selection, with no React in it: what each row holds, which
// card each has chosen, and the pieces a log or a save takes from them.
// OutfitComposer draws it; the tests drive it the way a thumb would.

/** The slots that hold one piece each; accessories hold any number. */
export type Slot = Exclude<GarmentType, 'accessory'>
export type Rows = Record<GarmentType, Garment[]>
export interface Picked {
  top: string | null
  bottom: string | null
  onepiece: string | null
  outerwear: string | null
  shoes: string | null
  accessories: string[]
}
export interface Selection {
  picked: Picked
  /** The One-piece side of the Separates / One-piece switch. */
  onepiece: boolean
  /** Said under the rows when a look or an outfit put in them holds a piece no row can show. */
  note?: string
}

/** The two rows you open when you want them. */
export const OPTIONAL = ['outerwear', 'shoes'] as const
export type Optional = (typeof OPTIONAL)[number]

/** Why a piece is in a row it is not dealt to: the day holds it, and it is retired or in Trash. */
export const heldBadge = (g: Garment): string | null => (g.deletedAt ? 'In Trash' : g.archivedAt ? 'Retired' : null)

/**
 * What the day's latest look holds that the rows are not dealt: a retired
 * piece, or one in Trash. Each joins its row for the visit, first and badged,
 * so the rows show what the day really holds and Update look writes it back
 * unless you move that row. A piece deleted forever has no record, and no row
 * to join.
 */
export function heldPieces(look: Wear | undefined, garments: readonly Garment[], inTrash: readonly Garment[]): Garment[] {
  if (!look) return []
  const records = new Map([...garments, ...inTrash].filter(g => !g.purged).map(g => [g.id, g]))
  return [...new Set(look.garmentIds)].map(id => records.get(id)).filter((g): g is Garment => !!g && heldBadge(g) !== null)
}

/**
 * The rows, dealt in the order frozen when the composer mounted: a piece added
 * since goes on the end of its row, and one retired or deleted since drops
 * out. They never re-sort under a thumb during a visit. The day's held pieces
 * lead their rows.
 */
export function rowsOf(garments: readonly Garment[], frozen: readonly string[], held: readonly Garment[] = []): Rows {
  const rows = Object.fromEntries(GARMENT_TYPES.map(t => [t, held.filter(g => g.type === t)])) as Rows
  const live = new Map(garments.filter(g => !g.deletedAt && !g.archivedAt).map(g => [g.id, g]))
  for (const id of frozen) {
    const g = live.get(id)
    if (g) rows[g.type].push(g)
  }
  const dealt = new Set(frozen)
  for (const g of [...live.values()].filter(g => !dealt.has(g.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) rows[g.type].push(g)
  return rows
}

/** Every piece the rows show: one a log leaves out was seen there and moved on from. */
export const shownIn = (rows: Rows): Set<string> => new Set(GARMENT_TYPES.flatMap(t => rows[t].map(g => g.id)))

/**
 * A look or an outfit put in the rows. A slot it has a piece for takes it (the
 * first, when it has two); one it has none for keeps its card, except
 * outerwear and shoes, which go to None. A piece in no row leaves its row
 * where it was, and the note says why: "Old band tee is retired", "A piece
 * was deleted".
 */
export function load(sel: Selection, ids: readonly string[], rows: Rows, byId: ReadonlyMap<string, Garment>): Selection {
  const inRows = new Map(GARMENT_TYPES.flatMap(t => rows[t].map(g => [g.id, g] as const)))
  const picked: Picked = { ...sel.picked, outerwear: null, shoes: null, accessories: [] }
  const filled = new Set<GarmentType>()
  for (const id of ids) {
    const g = inRows.get(id)
    if (!g) continue
    if (g.type === 'accessory') picked.accessories.push(g.id)
    else if (!filled.has(g.type)) picked[g.type] = g.id
    filled.add(g.type)
  }
  const onepiece = filled.has('onepiece') ? true : filled.has('top') || filled.has('bottom') ? false : sel.onepiece
  return { picked, onepiece, note: notInUse(ids.filter(id => !inRows.has(id)), byId) || undefined }
}

/** Where the rows start: on the day's latest look when it has one, otherwise on each row's first card. */
export function start(rows: Rows, look: Wear | undefined, byId: ReadonlyMap<string, Garment>): Selection {
  const first: Selection = {
    picked: { top: rows.top[0]?.id ?? null, bottom: rows.bottom[0]?.id ?? null, onepiece: rows.onepiece[0]?.id ?? null, outerwear: null, shoes: null, accessories: [] },
    onepiece: false,
  }
  return look ? load(first, look.garmentIds, rows, byId) : first
}

/** What the rows have chosen, and so what a log or a save takes. */
export interface Chosen {
  /** Each slot's card: its pick while that is still in the row (a piece retired from its sheet mid-visit is not), else the row's first; None for outerwear and shoes. */
  slots: Record<Slot, string | null>
  accessories: string[]
  /** Separates and one-pieces both there, so the switch shows. */
  both: boolean
  /** The One-pieces row stands in for Tops and Bottoms. */
  onepieceMode: boolean
  /** The optional rows on screen: asked for, or holding a piece. */
  open: Optional[]
  /** The core, the open optional rows, then the accessories. */
  pieces: string[]
  /** A top and a bottom, or a one-piece, among them: enough to log or save. */
  dressed: boolean
}

export function chosenIn(sel: Selection, rows: Rows, asked: readonly Optional[]): Chosen {
  const member = (type: GarmentType, id: string | null) => (id && rows[type].some(g => g.id === id) ? id : null)
  const slots: Record<Slot, string | null> = {
    top: member('top', sel.picked.top) ?? rows.top[0]?.id ?? null,
    bottom: member('bottom', sel.picked.bottom) ?? rows.bottom[0]?.id ?? null,
    onepiece: member('onepiece', sel.picked.onepiece) ?? rows.onepiece[0]?.id ?? null,
    outerwear: member('outerwear', sel.picked.outerwear),
    shoes: member('shoes', sel.picked.shoes),
  }
  const accessories = sel.picked.accessories.filter(id => member('accessory', id))
  const separates = rows.top.length > 0 || rows.bottom.length > 0
  const onepieces = rows.onepiece.length > 0
  const onepieceMode = onepieces && (!separates || sel.onepiece)
  const open = OPTIONAL.filter(s => asked.includes(s) || !!slots[s])
  const pieces = [...(onepieceMode ? [slots.onepiece] : [slots.top, slots.bottom]), ...open.map(s => slots[s]), ...accessories].filter((id): id is string => !!id)
  // every piece chosen is in a row, held ones included, so the rows say what each is
  const inRows = new Map(GARMENT_TYPES.flatMap(t => rows[t].map(g => [g.id, g] as const)))
  return { slots, accessories, both: separates && onepieces, onepieceMode, open, pieces, dressed: coreKey(pieces, inRows) !== null }
}
