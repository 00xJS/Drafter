import { Item } from './types'
import { sanitizeItem } from './schema'
import { getSupabase } from './supabase'
import type { SyncInfo } from './syncengine'

/**
 * Why a round got no answer: no connection ('offline'), the server failed it
 * ('server' — a statement timeout on a full exchange, a 500), or the session
 * is no good ('auth'). They used to be one: anything but an expired token read
 * as "Offline — tap to retry", on a connection that was working fine.
 */
export type SyncProblem = 'offline' | 'server' | 'auth'

export interface SyncResult {
  /** Items newer than `since` (everything when since is null). Null when unreachable. */
  items: Item[] | null
  /** Ids the server refused to store. They stay dirty and are retried with backoff; they never clamp the cursor. */
  rejected: string[]
  /** Why the server refused an id, when it said. */
  reasons: Record<string, string>
  /**
   * Ids we pushed that did not change the server row, because the server's
   * updatedAt was >= ours: this device lost last-write-wins. The server puts
   * its current row for each of them in `items`, even when older than `since`.
   */
  stale: string[]
  /** Ids we pushed that the server had permanently purged; it did not re-insert them. */
  gone: string[]
  /**
   * Every row owned by SOMEONE ELSE, of a kind whose audience is per record
   * (note, task), that this account can see right now — whatever the cursor,
   * the full set, not a delta. A cached peer row that is not in it was
   * withheld, and this is the only way a reader can learn: an invisible row
   * cannot arrive in `items`, so silence would read as "nothing changed" and
   * the row would sit in their list forever.
   *
   * Null when the server did not say (a sync_posts older than v3.19, or the
   * legacy array shape). Null means "no information", never "nothing visible"
   * — a client that confused the two would empty its lists against an old
   * server.
   */
  peerShared: string[] | null
  /**
   * What a v3.16 server answers: the same set for NOTES ONLY. Kept because the
   * two say different things — a note-only list holds no task ids at all, so
   * reading one as the whole answer would revoke every peer task in the house.
   * `peerVisibleByKind` is the one place that decides which list covers which
   * kind; nothing else should read either field.
   */
  peerNotes: string[] | null
  /**
   * The kinds `peerShared` speaks for, when the server says (v3.31: note, meal,
   * task). Absent, a v3.19 server's list covers notes and tasks alone — read as
   * covering meals too, it would drop every meal a housemate shares.
   */
  peerSharedKinds?: string[] | null
  /** True when the failure was an expired/invalid session rather than the network. */
  authError: boolean
  /** Why there was no answer (items null), when it was not simply the network. */
  problem?: SyncProblem
  /** The server's own words, for a 'server' problem: Settings → Sync shows them. */
  message?: string
  /**
   * True when the server answered in the object shape — it says what it
   * refused. Then a sent row that is neither rejected nor echoed was accepted
   * unchanged, and the caller may count it confirmed.
   */
  reportsRejections: boolean
}

type RemoteRow = Item & { syncedAt?: string }

const OFFLINE: Omit<SyncResult, 'authError'> = { items: null, rejected: [], reasons: {}, stale: [], gone: [], peerShared: null, peerNotes: null, reportsRejections: false }

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function rows(list: unknown[]): RemoteRow[] {
  const items: RemoteRow[] = []
  for (const raw of list) {
    const syncedAt =
      raw && typeof raw === 'object' && typeof (raw as { syncedAt?: unknown }).syncedAt === 'string'
        ? (raw as { syncedAt: string }).syncedAt
        : undefined
    const clean = sanitizeItem(raw)
    if (clean) items.push(syncedAt ? { ...clean, syncedAt } : clean)
  }
  return items
}

/**
 * Read a sync_posts answer in any shape production has spoken or will speak:
 * the legacy bare array of rows; `{ items, rejected }`;
 * `{ items, rejected, stale, gone, peerNotes }`; and the same with
 * `peerShared`. A rejected entry may be a bare id or
 * `{ id, reason }`, and a `reasons` map is honoured too — whichever the server
 * sends, a reason is kept for Settings. Null for anything unrecognisable.
 */
export function parseSyncResponse(data: unknown): (Omit<SyncResult, 'authError' | 'items'> & { items: Item[] }) | null {
  if (Array.isArray(data)) return { ...OFFLINE, items: rows(data) }
  if (!data || typeof data !== 'object') return null
  const obj = data as { items?: unknown; rejected?: unknown; reasons?: unknown; stale?: unknown; gone?: unknown; peerNotes?: unknown; peerShared?: unknown; peerSharedKinds?: unknown }
  const rejected: string[] = []
  const reasons: Record<string, string> = {}
  for (const entry of Array.isArray(obj.rejected) ? obj.rejected : []) {
    if (typeof entry === 'string') rejected.push(entry)
    else if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      const e = entry as { id: string; reason?: unknown; error?: unknown; message?: unknown }
      rejected.push(e.id)
      const why = [e.reason, e.error, e.message].find((x): x is string => typeof x === 'string' && x.trim() !== '')
      if (why) reasons[e.id] = why
    }
  }
  if (obj.reasons && typeof obj.reasons === 'object' && !Array.isArray(obj.reasons)) {
    for (const [id, why] of Object.entries(obj.reasons as Record<string, unknown>)) {
      if (typeof why === 'string' && why.trim() && !reasons[id]) reasons[id] = why
    }
  }
  return {
    items: rows(Array.isArray(obj.items) ? obj.items : []),
    rejected,
    reasons,
    stale: ids(obj.stale),
    gone: ids(obj.gone),
    // only an array is an answer; a server that says nothing revokes nothing
    peerShared: Array.isArray(obj.peerShared) ? ids(obj.peerShared) : null,
    peerNotes: Array.isArray(obj.peerNotes) ? ids(obj.peerNotes) : null,
    peerSharedKinds: Array.isArray(obj.peerSharedKinds) ? ids(obj.peerSharedKinds) : null,
    reportsRejections: true,
  }
}

/**
 * A failed sync_posts call, told apart. No answer at all — postgrest-js says
 * status 0 when the fetch itself failed — or a browser that knows it is
 * offline is the network. A 401 or a token PostgREST calls expired is the
 * session: signing in again is the fix. Anything else is the server, and its
 * message is kept for Settings: a working connection is not the problem.
 */
export function classifySyncFailure(error: { message?: string; code?: string } | null | undefined, status: number | undefined, online = true): { problem: SyncProblem; message?: string } {
  if (!online || status === 0) return { problem: 'offline' }
  const text = `${error?.message ?? ''} ${error?.code ?? ''}`.toLowerCase()
  if (status === 401 || text.includes('jwt') || /\bpgrst30[1-3]\b/.test(text)) return { problem: 'auth' }
  // with no session the call runs as anon and meets "permission denied" — a
  // 401 above; with no status to go by, that reading stands
  if (status === undefined && text.includes('permission denied')) return { problem: 'auth' }
  const said = error?.message?.trim()
  return { problem: 'server', message: said ? said.slice(0, 300) : status ? `The server answered ${status}` : undefined }
}

/**
 * Delta sync against the sync_posts RPC: push dirty items, receive rows newer
 * than the synced_at cursor. `since: null` is a full exchange.
 *
 * A row the server refuses comes back as a bare id: sync_posts (v3.31) says
 * which, not why, so Settings can show a reason only where an older server
 * shape gave one. Saying why would take a sync_posts change of its own.
 */
export async function syncNow(outgoing: Item[], since: string | null): Promise<SyncResult> {
  const sb = getSupabase()
  if (!sb) return { ...OFFLINE, authError: false }
  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  let data: unknown
  try {
    const res = await sb.rpc('sync_posts', { incoming: outgoing, since })
    if (res.error) {
      console.error('Supabase sync failed:', res.error.message)
      const why = classifySyncFailure(res.error, res.status, online)
      return { ...OFFLINE, authError: why.problem === 'auth', ...why }
    }
    data = res.data
  } catch (e) {
    // a thrown fetch is the network, not the session
    console.error('Supabase sync failed:', e)
    return { ...OFFLINE, authError: false, problem: 'offline' }
  }
  const parsed = parseSyncResponse(data)
  return parsed ? { ...parsed, authError: false } : { ...OFFLINE, authError: false, problem: 'server', message: 'The server’s answer could not be read' }
}

/** What the top bar's sync pill says, to a screen reader and on hover. */
export function syncPillLabel(configured: boolean, info: Pick<SyncInfo, 'online' | 'authError' | 'problem'>): string {
  if (!configured) return 'Stored on this device — no account to sync with'
  if (info.online) return 'Synced — tap to sync now'
  if (info.problem === 'auth' || info.authError) return 'Session expired — sign in again to sync'
  if (info.problem === 'server') return 'Sync failed on the server — tap to try again'
  if (info.problem === 'offline') return 'Offline — tap to retry'
  return 'Not synced yet — tap to sync now'
}

/**
 * The content-free tombstone "Delete forever" writes for a kind. Every
 * sanitizer accepts this shape when deletedAt is set (see schema.ts), or a
 * device that still holds the live copy would discard the tombstone and keep
 * showing the record. `now` is its updatedAt — newerStamp of the record it
 * replaces, so it wins against that copy everywhere — and `deletedAt`, which
 * starts the 90-day clock, is the wall clock (the same instant by default).
 */
export function purgeTombstone(kind: Item['kind'], id: string, now: string, deletedAt = now): Record<string, unknown> {
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
 * Which list is authoritative for each per-record kind.
 *
 * A v3.31 server answers `peerShared` with `peerSharedKinds` naming the kinds
 * it covers (note, meal, task); a v3.19 one answers `peerShared` alone, which
 * covers notes AND tasks; a v3.16 one answers `peerNotes`, which covers notes
 * alone and has nothing to say about tasks. A kind left out is "no
 * information", and the caller revokes nothing of it — reading a note-only
 * list as the whole answer would drop every task a housemate owns.
 */
export function peerVisibleByKind(r: Pick<SyncResult, 'peerShared' | 'peerNotes' | 'peerSharedKinds'>): Partial<Record<string, string[] | null>> {
  if (r.peerShared && r.peerSharedKinds) return Object.fromEntries(r.peerSharedKinds.map(kind => [kind, r.peerShared]))
  if (r.peerShared) return { note: r.peerShared, task: r.peerShared }
  return { note: r.peerNotes, task: null }
}
