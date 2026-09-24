import { GARMENT_TYPES, type Garment, type GarmentType, type Season, type Wear } from '../../types'
import { coreKey, fitsOccasion, inSeason, notInUse, type DayOccasion } from '../../wardrobe'

// The look card's selection, with no React in it: which pieces each slot can
// hold, which one it holds, and the pieces a log or a save takes from them.
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
  /** Said on the card when a look or an outfit put on it holds a piece no slot can show. */
  note?: string
}

/** The two slots you open when you want them. */
export const OPTIONAL = ['outerwear', 'shoes'] as const
export type Optional = (typeof OPTIONAL)[number]

/** Why a piece is on the card though no picker offers it: the day holds it, and it is retired or in Trash. */
export const heldBadge = (g: Garment): string | null => (g.deletedAt ? 'In Trash' : g.archivedAt ? 'Retired' : null)

/**
 * What the day's latest look holds that no picker offers: a retired piece, or
 * one in Trash. Each joins its type for the visit, first and badged, so the
 * card shows what the day really holds and Update look writes it back unless
 * you change that slot. A piece deleted forever has no record, and no slot to
 * hold it.
 */
export function heldPieces(look: Wear | undefined, garments: readonly Garment[], inTrash: readonly Garment[]): Garment[] {
  if (!look) return []
  const records = new Map([...garments, ...inTrash].filter(g => !g.purged).map(g => [g.id, g]))
  return [...new Set(look.garmentIds)].map(id => records.get(id)).filter((g): g is Garment => !!g && heldBadge(g) !== null)
}

/**
 * The pieces each slot can hold: every live, unretired piece of its type, by
 * name, with the day's held pieces leading their type. By name, so what lists
 * them as they are — the accessory chips — keeps one order visit after visit
 * and day after day; the picker sorts its own copy by rest as it opens
 * (board.ts pickerOrder). This says who is in, not who comes first.
 */
export function rowsOf(garments: readonly Garment[], held: readonly Garment[] = []): Rows {
  const live = garments.filter(g => !g.deletedAt && !g.archivedAt).sort(byName)
  return Object.fromEntries(GARMENT_TYPES.map(t => [t, [...held.filter(g => g.type === t), ...live.filter(g => g.type === t)]])) as Rows
}

/** A–Z, then the older first, then by id: one order for two pieces of one name. */
export const byName = (a: Garment, b: Garment): number => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/** Every piece the card can show: one a log leaves out was offered and passed over. */
export const shownIn = (rows: Rows): Set<string> => new Set(GARMENT_TYPES.flatMap(t => rows[t].map(g => g.id)))

/**
 * A look or an outfit put on the card. A slot it has a piece for takes it (the
 * first, when it has two); one it has none for keeps what it holds, except
 * outerwear and shoes, which empty. A piece no slot can hold leaves its slot
 * as it was, and the note says why: "Old band tee is retired", "A piece was
 * deleted".
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

/**
 * Where the card starts: on the day's latest look when it has one, and empty
 * when it has not.
 *
 * The swiping rows used to start on each row's first card, which meant a day
 * you had not dressed was indistinguishable from one you had — a top and a
 * bottom showed either way, "Wearing this" was live, and a press logged a look
 * nobody had chosen. For a wardrobe whose whole point is what you actually
 * wore, a guess that looks like a record is the one thing it must not do.
 */
export function start(rows: Rows, look: Wear | undefined, byId: ReadonlyMap<string, Garment>): Selection {
  const nothing: Selection = {
    picked: { top: null, bottom: null, onepiece: null, outerwear: null, shoes: null, accessories: [] },
    onepiece: false,
  }
  return look ? load(nothing, look.garmentIds, rows, byId) : nothing
}

/** What the card holds, and so what a log or a save takes. */
export interface Chosen {
  /** Each slot's piece: its pick while that can still be held (a piece retired from its sheet mid-visit cannot), else none. */
  slots: Record<Slot, string | null>
  accessories: string[]
  /** Separates and one-pieces both there, so the switch shows. */
  both: boolean
  /** The One-piece slot stands in for the top and the bottom. */
  onepieceMode: boolean
  /** The optional slots on the card: asked for, or holding a piece. */
  open: Optional[]
  /** The core, the open optional slots, then the accessories. */
  pieces: string[]
  /** A top and a bottom, or a one-piece, among them: enough to log or save. */
  dressed: boolean
}

export function chosenIn(sel: Selection, rows: Rows, asked: readonly Optional[]): Chosen {
  const member = (type: GarmentType, id: string | null) => (id && rows[type].some(g => g.id === id) ? id : null)
  // No slot falls back to a piece of its own choosing — not on a day nobody
  // has dressed, and not when a piece leaves mid-visit (retired from its own
  // sheet). Either way the slot empties and says so, rather than standing on
  // a garment the wearer never chose.
  const slots: Record<Slot, string | null> = {
    top: member('top', sel.picked.top),
    bottom: member('bottom', sel.picked.bottom),
    onepiece: member('onepiece', sel.picked.onepiece),
    outerwear: member('outerwear', sel.picked.outerwear),
    shoes: member('shoes', sel.picked.shoes),
  }
  const accessories = sel.picked.accessories.filter(id => member('accessory', id))
  const separates = rows.top.length > 0 || rows.bottom.length > 0
  const onepieces = rows.onepiece.length > 0
  const onepieceMode = onepieces && (!separates || sel.onepiece)
  const open = OPTIONAL.filter(s => asked.includes(s) || !!slots[s])
  const pieces = [...(onepieceMode ? [slots.onepiece] : [slots.top, slots.bottom]), ...open.map(s => slots[s]), ...accessories].filter((id): id is string => !!id)
  // every piece chosen is one a slot can hold, held ones included, so the card says what each is
  const inRows = new Map(GARMENT_TYPES.flatMap(t => rows[t].map(g => [g.id, g] as const)))
  return { slots, accessories, both: separates && onepieces, onepieceMode, open, pieces, dressed: coreKey(pieces, inRows) !== null }
}

/** A slot given a piece, or emptied. The card's note goes: what it explained has moved. */
export const pickSlot = (sel: Selection, slot: Slot, id: string | null): Selection => ({ ...sel, note: undefined, picked: { ...sel.picked, [slot]: id } })

/** An accessory put on, or taken off. */
export function toggleAccessory(sel: Selection, id: string): Selection {
  const on = sel.picked.accessories.includes(id)
  return { ...sel, note: undefined, picked: { ...sel.picked, accessories: on ? sel.picked.accessories.filter(x => x !== id) : [...sel.picked.accessories, id] } }
}

/**
 * An idea put on the card: its core takes the top and the bottom, or the
 * one-piece, and its coat the outerwear; the shoes and the accessories stay
 * as they are, as an idea says nothing about them. Nothing is saved.
 */
export function loadIdea(sel: Selection, ids: readonly string[], rows: Rows): Selection {
  const inRows = new Map(GARMENT_TYPES.flatMap(t => rows[t].map(g => [g.id, g] as const)))
  const picked: Picked = { ...sel.picked }
  let onepiece = sel.onepiece
  for (const id of ids) {
    const g = inRows.get(id)
    if (!g || g.type === 'accessory') continue
    picked[g.type] = g.id
    if (g.type === 'onepiece') onepiece = true
    else if (g.type === 'top' || g.type === 'bottom') onepiece = false
  }
  return { picked, onepiece }
}

/**
 * What an idea draws a slot from: the pieces of its type (not one only held
 * for the day, retired or in Trash) that fit the day's `occasion` — for it,
 * or for any time — and of those the ones in `season`. A type with none for
 * the day draws nothing; one with none in season keeps the day's pieces, as a
 * season is a lean, not a rule.
 */
export function ideaPool(row: readonly Garment[], season: Season, occasion?: DayOccasion): Garment[] {
  const dealt = row.filter(g => !heldBadge(g))
  const day = occasion ? dealt.filter(g => fitsOccasion(g, occasion)) : dealt
  const inTime = day.filter(g => inSeason(g, season))
  return inTime.length > 0 ? inTime : day
}
