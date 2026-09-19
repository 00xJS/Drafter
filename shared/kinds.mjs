// Record kinds, for code that has to agree with the database about them.
//
// SYNC_KINDS is the sync_posts allowlist (v3.9, 20260918; 'note' in v3.13,
// 20260922; the wardrobe's 'garment', 'outfit' and 'wear' in v3.14, 20260923): a
// kind the server has not been told about is rejected, and the row sits on one
// device looking saved. PERSONAL_KINDS belong to one account even inside a household: the
// "household access" policies on posts and posts_history hide them from peers
// (v3.10, 20260919; the wardrobe in v3.14, 20260923), so anything that reads
// with the service key — which bypasses every policy — has to apply the same
// rule itself.
//
// 'meal' joined them in v3.15 because the ids carried no owner (meal~date~slot)
// and two people planning the same slot overwrote each other. The id now
// carries the member, so v3.21 takes meals back out: a dinner is the week's
// food, like the grocery list, and hiding it is how one member planned a meal
// the other never saw. Grocery was never on this list.
//
// The app still carries its own copies (KNOWN_KINDS in src/schema.ts,
// PERSONAL_KINDS in src/store.ts); src/__tests__/srv-kinds.test.ts holds them,
// the migrations and this file together until they import from here.

export const SYNC_KINDS = new Set(['task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note', 'garment', 'outfit', 'wear'])

export const PERSONAL_KINDS = new Set(['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear'])

/** A stored row's kind: rows written before `kind` existed are tasks, as `coalesce(data->>'kind', 'task')` reads them. */
export function kindOf(data) {
  return data?.kind ?? 'task'
}

/**
 * Whether `readerId` may read a row of `kind` owned by `ownerId`, as far as the
 * kind goes: a personal kind is its owner's alone. Household membership is the
 * caller's own check (household_user_ids() in the policy).
 *
 * The kind is not the whole answer any more — a note is its owner's until they
 * share it (v3.16) — so a reader holding the row should call readableRow.
 */
export function readableKind(kind, ownerId, readerId) {
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
export const SHARED_BY_DEFAULT = { note: false, task: true, meal: true }

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
export function readableRow(data, ownerId, readerId) {
  if (!!readerId && ownerId === readerId) return true
  const kind = kindOf(data)
  if (PERSONAL_KINDS.has(kind)) return false
  // the kinds whose audience is per record rather than per kind
  if (kind in SHARED_BY_DEFAULT) return sharedFlag(data) ?? SHARED_BY_DEFAULT[kind]
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
export function sharedFlag(data) {
  const flag = data?.shared
  if (flag === undefined || flag === null) return null
  return flag === true
}
