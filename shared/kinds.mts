// Record kinds, for code that has to agree with the database about them.
//
// The database's list is public.record_kinds (v3.31, 20261008000000): a row per
// kind, saying whether it is personal and, for a kind whose audience is decided
// per record, what a row without `shared` means. sync_posts, the posts policy
// and account deletion all read it, so a kind reaches the database through one
// insert migration. This file is the code's copy of the same three facts, and
// src/__tests__/srv-kinds.test.ts holds the two together.
//
// SYNC_KINDS is every kind sync_posts stores: a kind the server has not been
// told about is rejected, and the row sits on one device looking saved.
// PERSONAL_KINDS belong to one account even inside a household: the posts
// policy hides them from peers, so anything that reads with the service key —
// which bypasses every policy — has to apply the same rule itself.
//
// 'meal' joined them in v3.15 because the ids carried no owner (meal~date~slot)
// and two people planning the same slot overwrote each other. The id now
// carries the member, so v3.21 takes meals back out: a dinner is the week's
// food, like the grocery list, and hiding it is how one member planned a meal
// the other never saw. Grocery was never on this list.
//
// 'snooze' joined in v3.24: a nudge put off is personal for the same reason a
// work day is. Maria saying "not this fortnight" about her mother must not be
// read as Joseph having called her.
//
// v3.26 adds the two halves of the chat, and they are deliberately two kinds.
// 'message' is the household's by kind, because a message nobody else can read
// is not a message. 'chat' — a turn of the conversation with the assistant — is
// PERSONAL: asking what your week looks like is not something said to the
// household, and the two must never end up in one thread.
//
// v3.27 adds 'account': a name, a kind and the balances you have typed in. The
// household's, like a bill — two people who share the rent share the picture.
//
// v3.32 adds 'notice', an entry in the notification hub: "Maria finished
// “Take bins out”", this morning's digest. PERSONAL, because the row is its
// recipient's (the server writes it under their id): the member it is about
// never reads the notice their housemate got, and neither does the backup,
// the digest or an assistant working for anyone else.
//
// v3.35 adds 'recipedraft': a recipe's draft, prepared overnight and waiting
// for someone to tap Save (src/types.ts RecipeDraftRecord). It is read exactly
// as a recipe is — the household's by kind, neither personal nor decided per
// record — because it is a proposal FOR the recipe: whoever can read the
// recipe, and so fill it in, must see the draft waiting for it, or the other
// member would find a recipe "ready" on one phone and bare on the other. The
// nightly job writes each one as the recipe's own owner (lib/writeas.mjs), so
// its reach is the recipe's. Nothing in it is anyone's own words but the
// recipe's, which the household already reads.
//
// The app imports these (KNOWN_KINDS in src/schema.ts, PERSONAL_KINDS in
// src/store.ts); the bot edge function cannot, and mcp.test.ts holds its copy.

import { isRecord } from './domain.mts'

/** The sync_posts allowlist: every kind the server stores. */
export const SYNC_KINDS: ReadonlySet<string> = new Set(['task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note', 'garment', 'outfit', 'wear', 'snooze', 'message', 'chat', 'account', 'notice', 'recipedraft'])

/** Kinds only their owner may read, even inside a household. */
export const PERSONAL_KINDS: ReadonlySet<string> = new Set(['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'snooze', 'chat', 'notice'])

/**
 * One field of a stored row's `data`, which is JSON: whatever the row was
 * written with, and nothing at all when the data is not an object.
 */
const field = (data: unknown, name: string): unknown => (isRecord(data) ? data[name] : undefined)

/**
 * A stored row's kind: rows written before `kind` existed are tasks, as
 * `coalesce(data->>'kind', 'task')` reads them. The app writes a string; a
 * row written some other way hands back whatever its `kind` holds.
 */
export function kindOf(data: unknown): unknown {
  return field(data, 'kind') ?? 'task'
}

/**
 * Whether `readerId` may read a row of `kind` owned by `ownerId`, as far as the
 * kind goes: a personal kind is its owner's alone. Household membership is the
 * caller's own check (household_user_ids() in the policy).
 *
 * The kind is not the whole answer any more — a note is its owner's until they
 * share it (v3.16) — so a reader holding the row should call readableRow.
 */
export function readableKind(kind: string | null | undefined, ownerId: string | null | undefined, readerId: string | null | undefined): boolean {
  return !PERSONAL_KINDS.has(kind ?? 'task') || (!!readerId && ownerId === readerId)
}

/**
 * The kinds whose audience is decided per RECORD rather than per kind, and
 * what each one's `shared` means when it is absent.
 *
 * A note is the place things are written down before anyone decides who they
 * are for, so it is private until its owner shares it (v3.16). A task is
 * household work — the board, Today, the calendar and the ICS feed are built
 * on both members seeing it — so it is the household's until its owner
 * withholds it (v3.19). A new task now writes `false` (v3.23) so it stays
 * private until shared; rows with no flag remain the household's. A meal is
 * the week's food the same way (v3.21), and
 * v3.22 lets a slot be kept to yourself; absent stays shared. Absent means
 * the default either way, which is what every row written before each change
 * carries.
 */
export const SHARED_BY_DEFAULT: Readonly<Record<string, boolean>> = { note: false, task: true, meal: true }

/**
 * Whether `readerId` may read this row, kind AND record. Use this wherever the
 * row itself is in hand; readableKind only answers the part a kind can answer.
 *
 * Everything the "household access" policy decides, for the readers that never
 * meet it: the service key bypasses RLS, so the ICS feed, the nightly backup,
 * the morning digest and the MCP server each apply this themselves. A peer's
 * unshared note reaching any of them is the same leak as a peer's journal —
 * the backup is one signed link away from whoever holds Admin.
 *
 * `shared` absent reads as the kind's default: not shared for a note, shared
 * for a task.
 */
export function readableRow(data: unknown, ownerId: string | null | undefined, readerId: string | null | undefined): boolean {
  if (!!readerId && ownerId === readerId) return true
  const kind = kindOf(data)
  if (typeof kind === 'string' && PERSONAL_KINDS.has(kind)) return false
  // the kinds whose audience is per record rather than per kind; `in` reads a
  // kind as text, whatever the row holds
  const key = String(kind)
  if (key in SHARED_BY_DEFAULT) return sharedFlag(data) ?? SHARED_BY_DEFAULT[key]
  return true
}

/**
 * A record's own `shared`, or null when it carries none and the kind's default
 * decides.
 *
 * Absent means absent the way the policy's coalesce means it, and a JSON null
 * is absent too: `data ->> 'shared'` is NULL for both. Anything else must BE
 * the boolean true to share. The policy compares text, so it would also accept
 * the STRING "true" — this does not, deliberately, and the app never writes
 * one. Erring that way can only withhold a row the database would have served;
 * erring the other way would serve one the database withholds, and these are
 * the readers that bypass the database entirely.
 */
export function sharedFlag(data: unknown): boolean | null {
  const flag = field(data, 'shared')
  if (flag === undefined || flag === null) return null
  return flag === true
}
