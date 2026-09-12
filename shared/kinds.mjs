// Record kinds, for code that has to agree with the database about them.
//
// SYNC_KINDS is the sync_posts allowlist (v3.9, 20260918): a kind the server
// has not been told about is rejected, and the row sits on one device looking
// saved. PERSONAL_KINDS belong to one account even inside a household: the
// "household access" policies on posts and posts_history hide them from peers
// (v3.10, 20260919), so anything that reads with the service key — which
// bypasses every policy — has to apply the same rule itself.
//
// The app still carries its own copies (KNOWN_KINDS in src/schema.ts,
// PERSONAL_KINDS in src/store.ts); src/__tests__/srv-kinds.test.ts holds them,
// the migrations and this file together until they import from here.

export const SYNC_KINDS = new Set(['task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine'])

export const PERSONAL_KINDS = new Set(['journal', 'review', 'calendar', 'habit', 'routine'])

/** A stored row's kind: rows written before `kind` existed are tasks, as `coalesce(data->>'kind', 'task')` reads them. */
export function kindOf(data) {
  return data?.kind ?? 'task'
}

/**
 * Whether `readerId` may read a row of `kind` owned by `ownerId`, as far as the
 * kind goes: a personal kind is its owner's alone. Household membership is the
 * caller's own check (household_user_ids() in the policy).
 */
export function readableKind(kind, ownerId, readerId) {
  return !PERSONAL_KINDS.has(kind ?? 'task') || (!!readerId && ownerId === readerId)
}
