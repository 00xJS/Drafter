// Wardrobe photos in the media bucket, for the code on either side that has to
// agree about which ones may be deleted: the app when a piece's photo is
// replaced, and the server's nightly sweep and account clean-up.
//
// A garment's photo is personal: filed under personal/<user id>/<uid> by
// src/media.ts, readable, replaceable and deletable by that account alone
// (v3.14, 20260923). Note photos and task images are bare ids the household
// shares, and backups/ holds the daily snapshots; nothing here ever names
// either as one that may go. Dependency-free ESM.

export const PERSONAL_PREFIX = 'personal/'

/** An account id, as the folder names it. */
const USER_ID = /^[0-9a-f-]{36}$/i
/** A media-store uid: the same tail sanitizeGarment keeps (src/schema.ts). */
const UID = /^[0-9a-z-]{8,64}$/i

/** The folder an account's wardrobe photos live in. */
export function personalFolder(userId) {
  return `${PERSONAL_PREFIX}${userId}/`
}

/** One of this account's own wardrobe photos: personal/<userId>/<uid>, directly in its folder, and nothing else. */
export function isPersonalMediaOf(id, userId) {
  if (typeof id !== 'string' || typeof userId !== 'string' || !USER_ID.test(userId)) return false
  const folder = personalFolder(userId)
  return id.startsWith(folder) && UID.test(id.slice(folder.length))
}

/**
 * Every photo a piece of clothing still points at: a live piece's, and one's in
 * Trash, so Restore brings it back whole. A piece deleted forever is a
 * content-free tombstone and points at nothing. With `expiredBefore`, a piece
 * deleted before that instant — gone from every device's Trash — no longer
 * counts either; one whose deletion can't be read still does.
 */
export function garmentMediaIds(records, opts = {}) {
  const cutoff = opts.expiredBefore ? Date.parse(opts.expiredBefore) : NaN
  const ids = new Set()
  for (const r of records ?? []) {
    if (r?.kind !== 'garment' || r.purged) continue
    if (r.deletedAt && Date.parse(r.deletedAt) < cutoff) continue
    for (const id of [r.photoId, r.thumbId]) if (typeof id === 'string' && id) ids.add(id)
  }
  return ids
}
