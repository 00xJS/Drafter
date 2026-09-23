import type { Item, Note } from './types'
import type { KindLists } from './syncengine'

// The lists every view renders, each drawn from ONE kind's array in the
// engine's state (EngineState.byKind). A list is drawn again only when its
// kind's array is a different one — a record of that kind changed — or, for a
// list that asks whose a record is, when the signed-in account changes. So
// editing a task hands Kitchen the very recipes array it had, and every memo
// downstream that reads it stays put.

/** The Notes list order: pinned first, then the most recently edited (ties by id, so the order is stable). */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>

interface Spec<K extends Item['kind'], T> {
  kind: K
  /** Reads whose a record is (`myId`): drawn again when the account changes, too. */
  mine?: true
  draw(list: readonly Of<K>[], myId: string | null): T[]
}

const spec = <K extends Item['kind'], T>(s: Spec<K, T>): Spec<K, T> => s

/** Mine, or unowned (local mode, rows from before households). */
const isMine = (i: Item, myId: string | null) => !i.ownerId || !myId || i.ownerId === myId
const live = <T extends Item>(list: readonly T[]): T[] => list.filter(i => !i.deletedAt)
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
const byCreated = (a: Item, b: Item) => a.createdAt.localeCompare(b.createdAt)

/**
 * Every list the store hands the views, and how it is drawn from its kind.
 * Personal kinds (PERSONAL_KINDS) show only mine; the household's show everyone's.
 */
export const LISTS = {
  /** Live tasks (tombstoned ones filtered out) — what every view renders. */
  tasks: spec({ kind: 'task', draw: live }),
  projects: spec({ kind: 'project', draw: l => live(l).sort(byCreated) }),
  people: spec({ kind: 'person', draw: l => live(l).sort(byName) }),
  places: spec({ kind: 'place', draw: l => live(l).sort(byName) }),
  recipes: spec({ kind: 'recipe', draw: l => live(l).sort(byName) }),
  // the household's, unless its owner kept it to themselves (v3.22)
  meals: spec({
    kind: 'meal',
    mine: true,
    draw: (l, myId) => l.filter(i => !i.deletedAt && (isMine(i, myId) || i.shared !== false)).sort((a, b) => a.date.localeCompare(b.date)),
  }),
  groceries: spec({ kind: 'grocery', draw: live }),
  // Entries you wrote yourself. Household-visible like tasks: a block of time
  // on a family calendar is meant to be seen, unlike a `calendar` subscription.
  events: spec({ kind: 'event', draw: l => live(l).sort((a, b) => a.start.localeCompare(b.start)) }),
  // Journal entries are personal, like reviews: only mine (or unowned, local-mode rows).
  journal: spec({
    kind: 'journal',
    mine: true,
    draw: (l, myId) => l.filter(i => !i.deletedAt && isMine(i, myId)).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)),
  }),
  reviews: spec({ kind: 'review', mine: true, draw: (l, myId) => l.filter(i => !i.deletedAt && isMine(i, myId)) }),
  habits: spec({
    kind: 'habit',
    mine: true,
    draw: (l, myId) => l.filter(i => !i.deletedAt && !i.archivedAt && isMine(i, myId)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || byCreated(a, b)),
  }),
  routines: spec({
    kind: 'routine',
    mine: true,
    draw: (l, myId) => l.filter(i => !i.deletedAt && !i.archivedAt && isMine(i, myId)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || byCreated(a, b)),
  }),
  // Household-shared like tasks: a peer's note shows, so no isMine filter.
  notes: spec({ kind: 'note', draw: l => sortNotes(live(l)) }),
  templates: spec({ kind: 'template', draw: l => live(l).sort(byName) }),
  // The wardrobe is personal, like the journal. A retired piece stays in the
  // list; each view leaves it out where it should.
  garments: spec({ kind: 'garment', mine: true, draw: (l, myId) => l.filter(i => !i.deletedAt && isMine(i, myId)).sort(byName) }),
  garmentsInTrash: spec({ kind: 'garment', mine: true, draw: (l, myId) => l.filter(i => !!i.deletedAt && !i.purged && isMine(i, myId)) }),
  outfits: spec({ kind: 'outfit', mine: true, draw: (l, myId) => l.filter(i => !i.deletedAt && isMine(i, myId)).sort(byCreated) }),
  wears: spec({
    kind: 'wear',
    mine: true,
    draw: (l, myId) => l.filter(i => !i.deletedAt && isMine(i, myId)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
  }),
  calendars: spec({ kind: 'calendar', mine: true, draw: (l, myId) => l.filter(i => !i.deletedAt && isMine(i, myId)).sort(byCreated) }),
  // Accounts you keep a balance for. The household's, like a bill: two people
  // who share the rent share the picture. An archived one stays in the list;
  // the views that total money leave it out.
  accounts: spec({ kind: 'account', draw: l => live(l).sort(byName) }),
  // The household's chat, oldest first — the id carries the instant, so the
  // list sorts on it alone and needs no clock of its own.
  messages: spec({ kind: 'message', draw: l => live(l).sort((a, b) => a.id.localeCompare(b.id)) }),
  // Your side of the assistant conversation and its answers. Personal, like
  // the journal: what you ask Drafter is not household business.
  chat: spec({ kind: 'chat', mine: true, draw: (l, myId) => l.filter(i => !i.deletedAt && isMine(i, myId)).sort((a, b) => a.id.localeCompare(b.id)) }),
  // Nudges you have put off. Personal, like the journal: a peer's "not this
  // fortnight" is theirs, and never silences the nudge on this device.
  snoozes: spec({ kind: 'snooze', mine: true, draw: (l, myId) => l.filter(i => !i.deletedAt && isMine(i, myId)) }),
}

export type ListName = keyof typeof LISTS
export type Lists = { [N in ListName]: ReturnType<(typeof LISTS)[N]['draw']> }

const NAMES = Object.keys(LISTS) as ListName[]

/** The lists as last drawn, and what they were drawn from. */
export interface DrawnLists {
  byKind: KindLists
  myId: string | null
  lists: Lists
  /** The lists this drawing had to draw again; every other one is the previous drawing's own array. */
  rebuilt: ListName[]
}

/**
 * The lists for these records, reusing each list of `prev` whose kind's array
 * (and, for a list that reads whose a record is, the account) is unchanged.
 * With nothing to draw again it hands back `prev` itself.
 */
export function drawLists(byKind: KindLists, myId: string | null, prev?: DrawnLists | null): DrawnLists {
  if (prev && prev.byKind === byKind && prev.myId === myId) return prev
  const lists = {} as Record<ListName, unknown[]>
  const rebuilt: ListName[] = []
  for (const name of NAMES) {
    const s = LISTS[name] as Spec<Item['kind'], unknown>
    const kept = prev && prev.byKind[s.kind] === byKind[s.kind] && (!s.mine || prev.myId === myId)
    if (kept) lists[name] = prev.lists[name]
    else {
      lists[name] = s.draw(byKind[s.kind] as readonly Item[], myId)
      rebuilt.push(name)
    }
  }
  return { byKind, myId, lists: prev && rebuilt.length === 0 ? prev.lists : (lists as Lists), rebuilt }
}
