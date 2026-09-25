import type { CacheChanges, CacheRecord, Handoff } from './syncengine'
import type { Item } from './types'

const DB_NAME = 'drafter'
/**
 * v2: 'posts' — the local cache moved out of localStorage's 5MB quota, every
 *     record in ONE value under 'all' (rewritten whole after every change).
 * v3: 'records', one row per record keyed by its id, and 'meta', whose cache
 *     it is, the merge base of each record still to push and (since the
 *     bookkeeping left localStorage) the sync cursor, the dirty set and the
 *     refusals. An edit writes the one record it changed. The v2 value is moved
 *     over on the first write after it is read (src/syncengine.ts), and
 *     'posts' stays for the calendar's own cache (src/calendars.ts).
 */
const DB_VERSION = 3
const STORES = ['media', 'handles', 'posts', 'records', 'meta'] as const
/** The one row in 'meta' that describes the cache. */
const META_KEY = 'cache'
/**
 * Beside it in 'meta', one row per record another tab has edited and handed
 * to the tab that syncs (src/syncengine.ts, Handoff): `handoff:<record id>`.
 */
const HANDOFF_PREFIX = 'handoff:'
const outboxRange = () => IDBKeyRange.bound(HANDOFF_PREFIX, `${HANDOFF_PREFIX}￿`)

/** What 'meta' holds beside the records, written in the same transaction as they are. */
interface StoredMeta {
  version: number
  userId: string | null
  shadows: unknown[]
  /** The cursor, the dirty set and the refusals (syncstate.ts). Absent in a row an older build wrote. */
  sync?: unknown
  /** Which write this was, counting up: orders the unload journal against the cache. */
  seq?: number
}

/*
 * One connection for the page, opened on the first read or write and kept.
 * Every call used to open its own and close it when its transaction finished
 * — and a request that failed never finished, so its connection stayed open.
 * The kept one is let go (closed, and forgotten, so the next call opens a
 * fresh one) whenever it cannot be trusted any more:
 *   - another tab or sign-out wants the database changed or deleted
 *     (versionchange): a connection left open would hold that up;
 *   - the browser closed it underneath the page (close): WebKit does so to a
 *     frozen or backgrounded page, and under storage pressure;
 *   - a request on it failed: WebKit's "Connection to Indexed Database server
 *     lost" fails every later transaction on that connection too.
 */
let connection: Promise<IDBDatabase> | null = null
let connected: IDBDatabase | null = null

/** Close this connection and forget it, if it is the page's: the next call opens a fresh one. */
function release(db: IDBDatabase | null | undefined): void {
  if (!db) return
  if (db === connected) {
    connected = null
    connection = null
  }
  try {
    db.close()
  } catch {
    /* already closed */
  }
}

function open(): Promise<IDBDatabase> {
  if (connection) return connection
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      for (const s of STORES) {
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => release(db)
      db.onclose = () => release(db)
      // a release that came while this was opening leaves it unkept
      if (connection === opening) connected = db
      else db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
  connection = opening
  // an open that failed is not kept: the next call tries again
  opening.catch(() => {
    if (connection === opening) connection = null
  })
  return opening
}

/**
 * A transaction on the page's connection. One the browser closed without a
 * word refuses a transaction (InvalidStateError): it is let go, and the
 * transaction is asked of a fresh connection, once.
 */
async function begin(stores: string | string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
  for (let attempt = 0; ; attempt++) {
    const db = await open()
    try {
      return db.transaction(stores, mode)
    } catch (e) {
      release(db)
      if (attempt > 0 || (e as DOMException | null)?.name !== 'InvalidStateError') throw e
    }
  }
}

async function withStore<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const tx = await begin(store, mode)
  return new Promise<T>((resolve, reject) => {
    const req = fn(tx.objectStore(store))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => {
      reject(req.error)
      release(tx.db)
    }
  })
}

/**
 * One transaction over several stores, settled when it commits — or rejected
 * when it aborts, in which case none of it was written. A request that throws
 * while it is being queued (a record that cannot be cloned) aborts the lot,
 * rather than letting the requests queued before it commit on their own.
 */
async function transact(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => void): Promise<void> {
  const tx = await begin(stores, mode)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => {
      reject(tx.error)
      release(tx.db)
    }
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    try {
      fn(tx)
    } catch (e) {
      try {
        tx.abort()
      } catch {
        /* already finished */
      }
      reject(e)
    }
  })
}

export function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return withStore<T | undefined>(store, 'readonly', s => s.get(key))
}

export function idbSet(store: string, key: string, value: unknown): Promise<unknown> {
  return withStore(store, 'readwrite', s => s.put(value, key))
}

export function idbDel(store: string, key: string): Promise<unknown> {
  return withStore(store, 'readwrite', s => s.delete(key))
}

/** Every value in a store: the media upload queue reads its pending photos from here. */
export function idbAll<T>(store: string): Promise<T[]> {
  return withStore<T[]>(store, 'readonly', s => s.getAll())
}

/**
 * The per-record cache as one CacheRecord — the shape the single value had —
 * read in one transaction, so the records and the account they belong to are
 * from the same moment. Undefined when nothing has ever been written there:
 * the engine then reads the v2 value, and its first write moves it over.
 */
export function readRecordCache(): Promise<CacheRecord | undefined> {
  const early = prefetched
  prefetched = null
  return early ?? readRecordCacheNow()
}

let prefetched: Promise<CacheRecord | undefined> | null = null

/**
 * Start reading the cache now (main.tsx, for a device that opens straight to
 * its planner): the read runs beside the planner's chunk coming in, rather
 * than after it, and the engine's first read takes it. A read that fails is
 * not kept — the engine reads again, and tries again after that.
 */
export function prefetchRecordCache(): void {
  if (prefetched || typeof indexedDB === 'undefined') return
  const read = readRecordCacheNow()
  prefetched = read
  read.catch(() => {
    if (prefetched === read) prefetched = null
  })
}

async function readRecordCacheNow(): Promise<CacheRecord | undefined> {
  let items: unknown[] = []
  let meta: StoredMeta | undefined
  let outbox: Handoff[] = []
  await transact(['records', 'meta'], 'readonly', tx => {
    const all = tx.objectStore('records').getAll()
    all.onsuccess = () => (items = all.result)
    const row = tx.objectStore('meta').get(META_KEY)
    row.onsuccess = () => (meta = row.result as StoredMeta | undefined)
    const handed = tx.objectStore('meta').getAll(outboxRange())
    handed.onsuccess = () => (outbox = handed.result as Handoff[])
  })
  if (items.length === 0 && !meta && outbox.length === 0) return undefined
  // no meta beside records is a cache nothing wrote whole: its owner is unknown, as a pre-account cache's was
  return {
    version: meta?.version ?? 0,
    userId: meta ? meta.userId : undefined,
    items: items as CacheRecord['items'],
    shadows: (meta?.shadows ?? []) as CacheRecord['items'],
    sync: meta?.sync as CacheRecord['sync'],
    seq: typeof meta?.seq === 'number' ? meta.seq : undefined,
    outbox,
  }
}

/** The records under these ids as the cache holds them now, in one read: a tab that does not sync, catching up with one that does. */
export async function readRecords(ids: readonly string[]): Promise<Item[]> {
  const out: Item[] = []
  await transact(['records'], 'readonly', tx => {
    const store = tx.objectStore('records')
    for (const id of ids) {
      const req = store.get(id)
      req.onsuccess = () => void (req.result && out.push(req.result as Item))
    }
  })
  return out
}

/** Which write the cache is at (its meta row's `seq`), or null when none has counted. */
export async function readCacheSeq(): Promise<number | null> {
  const meta = await idbGet<StoredMeta>('meta', META_KEY)
  return typeof meta?.seq === 'number' ? meta.seq : null
}

/**
 * Edits made in a tab that does not sync, for the one that does: each beside
 * the copy it was made on, in one transaction, replacing any earlier one of
 * the same record that has not been taken yet.
 */
export function writeHandoffs(entries: readonly Handoff[]): Promise<void> {
  return transact(['meta'], 'readwrite', tx => {
    const meta = tx.objectStore('meta')
    for (const h of entries) meta.put(h, HANDOFF_PREFIX + h.id)
  })
}

/** Every edit waiting to be taken, and the records they name as the cache holds them — one read, so the two agree. */
export async function readOutbox(): Promise<{ entries: Handoff[]; records: Item[] }> {
  let entries: Handoff[] = []
  const records: Item[] = []
  await transact(['records', 'meta'], 'readonly', tx => {
    const handed = tx.objectStore('meta').getAll(outboxRange())
    handed.onsuccess = () => {
      entries = handed.result as Handoff[]
      const store = tx.objectStore('records')
      for (const h of entries) {
        const req = store.get(h.id)
        req.onsuccess = () => void (req.result && records.push(req.result as Item))
      }
    }
  })
  return { entries, records }
}

/**
 * Write what changed since the last write, in ONE transaction: the records
 * upserted and deleted, the account they belong to, the shadows and the sync
 * bookkeeping beside them, and — on the write that migrates it — the removal
 * of the v2 value. IndexedDB commits a transaction whole or not at all, so a
 * write cut short leaves the cache as it was: never a record without the
 * account it belongs to, never a dirty record without its merge base, never a
 * cursor past rows that are not saved, never the v2 value gone before its
 * records were copied.
 */
export function writeRecordChanges(change: CacheChanges): Promise<void> {
  const stores = change.dropSnapshot ? ['records', 'meta', 'posts'] : ['records', 'meta']
  return transact(stores, 'readwrite', tx => {
    const records = tx.objectStore('records')
    for (const id of change.deletes) records.delete(id)
    for (const item of change.upserts) records.put(item, item.id)
    const meta: StoredMeta = { version: change.version, userId: change.userId, shadows: change.shadows, sync: change.sync, seq: change.seq }
    const metaStore = tx.objectStore('meta')
    metaStore.put(meta, META_KEY)
    // Edits another tab handed over, taken into this write's dirty set: gone
    // in the same transaction, and only the very one taken — the tab may have
    // handed over a newer edit of the record meanwhile, which waits its turn.
    for (const done of change.handoffsDone ?? []) {
      const req = metaStore.get(HANDOFF_PREFIX + done.id)
      req.onsuccess = () => {
        if ((req.result as Handoff | undefined)?.hid === done.hid) metaStore.delete(HANDOFF_PREFIX + done.id)
      }
    }
    if (change.dropSnapshot) tx.objectStore('posts').delete('all')
  })
}

/**
 * Settings about the SCREEN rather than about the person, kept across a sign-out.
 *
 * Everything else under drafter:* goes, and has to — see clearLocalData. The
 * test for this list is narrow: a key belongs here only if reading it tells
 * you nothing whatsoever about the account that set it. `drafter:theme` is
 * "light" or "dark"; `drafter:home-folded` is a list of section NAMES, never
 * their contents. Somebody signing in next inherits a colour and some folded
 * headings, which is the same thing they would inherit from the device's own
 * dark-mode switch.
 *
 * What may NOT go here: anything naming a record, a person, a place, a date, a
 * count, or which tab got used most — that is the person's, and sign-out means
 * sign-out. When in doubt it is not a display setting.
 */
const KEPT_ACROSS_SIGN_OUT = new Set(['drafter:theme', 'drafter:home-folded'])

/**
 * Remove every trace of the signed-in person from this device: the cached
 * records, the photos, and every drafter:* preference but the handful in
 * KEPT_ACROSS_SIGN_OUT. Signing out has to do this — otherwise the whole
 * planner stays readable in DevTools on a shared, sold or stolen device, and
 * the next account to sign in inherits it.
 */
export async function clearLocalData(): Promise<void> {
  // cancel local reminders before wiping the flag that would otherwise leave
  // up to 60 pending notifications with task titles after sign-out
  try {
    const { scheduleLocalReminders } = await import('./native')
    await scheduleLocalReminders([])
  } catch {
    /* native bridge may be unavailable */
  }
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('drafter:') && !KEPT_ACROSS_SIGN_OUT.has(k)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* storage may be unavailable; carry on and still drop the database */
  }
  // Emptied first, store by store: a delete below that another tab's open
  // connection leaves waiting (or that the browser refuses) must not leave the
  // records readable in the meantime. Never waited on for long — an older tab
  // holding the database open would stall the upgrade this needs, and the
  // delete is the wipe either way.
  const emptied = transact([...STORES], 'readwrite', tx => {
    for (const s of STORES) tx.objectStore(s).clear()
  }).catch(() => {
    /* no database to empty; the delete below is the wipe */
  })
  await Promise.race([emptied, new Promise(resolve => setTimeout(resolve, 2_000))])
  // This page's own connection goes first, as a delete waits on every open
  // one (another tab's lets go when the delete asks, open()); one still
  // opening is closed as it lands.
  release(connected)
  connection = null
  await new Promise<void>(resolve => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}
