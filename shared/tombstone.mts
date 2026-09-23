// "Delete forever": what is left of a record — its kind, its id, when it went
// and who it is for — and nothing of what it said. The app writes one when a
// record is emptied from the Trash (src/syncengine.ts, purge); the nightly job
// writes the very same for a row left in the Trash past the 90 days every
// device keeps it (netlify/functions/lib/backup.mjs). Shared, so the two can
// never write different shapes. Dependency-free ESM.

/**
 * The content-free tombstone "Delete forever" writes for a kind. Every
 * sanitizer accepts this shape when deletedAt is set (see src/schema.ts), or
 * a device that still holds the live copy would discard the tombstone and keep
 * showing the record. `now` is its updatedAt — stamped newer than the record
 * it replaces, so it wins against that copy everywhere — and `deletedAt`,
 * which starts the 90-day clock, is the wall clock (the same instant by default).
 */
export function purgeTombstone(kind: string, id: string, now: string, deletedAt = now): Record<string, unknown> {
  const base = { kind, id, deletedAt, purged: true, updatedAt: now, createdAt: now }
  switch (kind) {
    case 'task':
      return { ...base, title: '', description: '', status: 'canceled', priority: 'normal', tags: [] }
    case 'project':
      return { ...base, name: '', color: '#888', status: 'archived' }
    case 'person':
    case 'place':
    case 'recipe':
    case 'template':
      return { ...base, name: '' }
    case 'meal':
      return { ...base, title: '', date: '', slot: 'dinner' }
    case 'grocery':
      return { ...base, weekKey: '', items: [] }
    case 'journal':
      // the day stays in the id (journal~YYYY-MM-DD~…); the body is gone on purpose
      return { ...base, date: /^journal~(\d{4}-\d{2}-\d{2})~/.exec(id)?.[1] ?? '', body: '' }
    case 'review':
      return { ...base, period: 'week', key: '', top: [] }
    case 'calendar':
      return { ...base, name: '', url: '', color: '#888', enabled: false }
    case 'note':
      return { ...base, title: '', body: '' }
    case 'garment':
      return { ...base, name: '', type: 'accessory' }
    case 'outfit':
      return { ...base, garmentIds: [] }
    case 'wear':
      // the day stays in the id (wear~YYYY-MM-DD~…); the pieces are gone on purpose
      return { ...base, date: /^wear~(\d{4}-\d{2}-\d{2})~/.exec(id)?.[1] ?? '', garmentIds: [] }
    default:
      return base
  }
}

/**
 * The tombstone of a stored record, saying who it is for as the record did.
 * That is not content: v3.16's `with check` refuses a write onto a note a
 * housemate shared that does not leave it shared, and a task kept private
 * (v3.19) would otherwise be put back to private by the server's own rule —
 * so the flag the row carried rides along. A row with no kind is a task, as
 * sync_posts reads one.
 */
export function tombstoneFor(record: { kind?: unknown; id: string; shared?: unknown }, now: string, deletedAt = now): Record<string, unknown> {
  const kind = typeof record.kind === 'string' && record.kind ? record.kind : 'task'
  const raw = purgeTombstone(kind, record.id, now, deletedAt)
  if (kind === 'note' && record.shared === true) return { ...raw, shared: true }
  if (kind === 'task' && record.shared === false) return { ...raw, shared: false }
  return raw
}
