// Who may see whose records, on the server: the households, as
// public.household_user_ids() reads them. The service key bypasses the posts
// policy, so the digest and Sunday's draft scope each reader's records with
// this (shared/digest.mts visibleItemsFor) exactly as the database would.

/**
 * userId -> the set of owner ids whose records that user may see (mirrors
 * household_user_ids()). `rest` is a service-key PostgREST helper; a household
 * list that cannot be read is no household, so each reader sees their own.
 */
export async function buildPeerMap(rest) {
  const rows = await rest('household_members?select=household_id,user_id').catch(() => [])
  const byHousehold = new Map()
  for (const r of rows ?? []) {
    if (!byHousehold.has(r.household_id)) byHousehold.set(r.household_id, [])
    byHousehold.get(r.household_id).push(r.user_id)
  }
  const peers = new Map()
  for (const members of byHousehold.values()) {
    for (const uid of members) {
      const set = peers.get(uid) ?? new Set()
      for (const other of members) set.add(other)
      peers.set(uid, set)
    }
  }
  return peers
}
