/*
 * A stand-in IndexedDB, in memory, with just what src/idb.ts uses: open and
 * deleteDatabase, object stores with get, put, delete, getAll and clear, and
 * transactions that complete once their requests are answered. It keeps
 * count of the connections opened, and lets a test do to a connection what a
 * browser does: close it underneath the page (WebKit, for a frozen page), or
 * fail its next request.
 *
 * Simplified where the tests do not look: a write lands when its request
 * succeeds, and an aborted transaction does not roll back.
 */

type Listener = ((event?: unknown) => void) | null

class FakeRequest<T = unknown> {
  result: T | undefined
  error: DOMException | null = null
  onsuccess: Listener = null
  onerror: Listener = null
  onupgradeneeded: Listener = null
  onblocked: Listener = null
}

const later = (fn: () => void) => setTimeout(fn, 0)

interface KeyRange {
  lower: string
  upper: string
}

class FakeStore {
  constructor(
    private tx: FakeTransaction,
    private rows: Map<string, unknown>,
  ) {}

  private request<T>(answer: () => T): FakeRequest<T> {
    return this.tx.request(answer)
  }

  get(key: string) {
    return this.request(() => structuredClone(this.rows.get(key)))
  }

  getAll(range?: KeyRange) {
    return this.request(() => [...this.rows].filter(([k]) => !range || (k >= range.lower && k <= range.upper)).map(([, v]) => structuredClone(v)))
  }

  put(value: unknown, key: string) {
    // cloned as it is queued, as a browser does: a value that cannot be cloned throws here
    const copy = structuredClone(value)
    return this.request(() => {
      this.rows.set(key, copy)
      return key
    })
  }

  delete(key: string) {
    return this.request(() => {
      this.rows.delete(key)
      return undefined
    })
  }

  clear() {
    return this.request(() => {
      this.rows.clear()
      return undefined
    })
  }
}

class FakeTransaction {
  oncomplete: Listener = null
  onerror: Listener = null
  onabort: Listener = null
  error: DOMException | null = null
  private pending = 0
  private done = false

  constructor(
    readonly db: FakeDatabase,
    private stores: string[],
  ) {}

  objectStore(name: string) {
    if (!this.stores.includes(name)) throw new DOMException(`${name} is not in this transaction`, 'NotFoundError')
    return new FakeStore(this, this.db.data(name))
  }

  request<T>(answer: () => T): FakeRequest<T> {
    if (this.done) throw new DOMException('the transaction has finished', 'TransactionInactiveError')
    const req = new FakeRequest<T>()
    this.pending++
    later(() => {
      if (this.done) return
      const failure = this.db.factory.takeFailure()
      if (failure) {
        req.error = failure
        this.error = failure
        req.onerror?.()
        this.onerror?.()
        this.finish('abort')
        return
      }
      req.result = answer()
      req.onsuccess?.()
      this.pending--
      if (this.pending === 0) later(() => this.pending === 0 && this.finish('complete'))
    })
    // a transaction nothing was asked of still completes
    return req
  }

  abort() {
    if (this.done) throw new DOMException('the transaction has finished', 'InvalidStateError')
    this.error = null
    this.finish('abort')
  }

  /** Completes with no request asked of it, as an empty transaction does. */
  settleIfIdle() {
    later(() => this.pending === 0 && !this.done && this.finish('complete'))
  }

  private finish(how: 'complete' | 'abort') {
    if (this.done) return
    this.done = true
    if (how === 'complete') this.oncomplete?.()
    else this.onabort?.()
    this.db.transactionDone(this)
  }
}

class FakeDatabase {
  onversionchange: Listener = null
  onclose: Listener = null
  /** close() was called, or the browser closed it: no new transactions. */
  closing = false
  /** Gone altogether: closed, with every transaction finished. */
  closed = false
  private active = new Set<FakeTransaction>()
  readonly objectStoreNames = { contains: (name: string) => this.factory.stores(this.name).has(name) }

  constructor(
    readonly factory: FakeIndexedDB,
    readonly name: string,
    readonly version: number,
  ) {}

  data(store: string): Map<string, unknown> {
    const rows = this.factory.stores(this.name).get(store)
    if (!rows) throw new DOMException(`no store ${store}`, 'NotFoundError')
    return rows
  }

  createObjectStore(name: string) {
    this.factory.stores(this.name).set(name, new Map())
  }

  transaction(stores: string | string[], _mode?: string) {
    if (this.closing) throw new DOMException('The database connection is closing.', 'InvalidStateError')
    const tx = new FakeTransaction(this, Array.isArray(stores) ? stores : [stores])
    this.active.add(tx)
    tx.settleIfIdle()
    return tx
  }

  close() {
    this.closing = true
    this.settle()
  }

  transactionDone(tx: FakeTransaction) {
    this.active.delete(tx)
    this.settle()
  }

  private settle() {
    if (this.closing && this.active.size === 0 && !this.closed) {
      this.closed = true
      this.factory.connectionClosed(this)
    }
  }
}

export class FakeIndexedDB {
  /** Connections opened, over the test. */
  opened = 0
  /** Deletes that had to wait on a connection left open (their `blocked`). */
  blocked = 0
  readonly connections = new Set<FakeDatabase>()
  private databases = new Map<string, { version: number; stores: Map<string, Map<string, unknown>> }>()
  private failures: DOMException[] = []
  private closeWaiters: (() => void)[] = []
  private deleting: Promise<void> | null = null

  stores(name: string) {
    let db = this.databases.get(name)
    if (!db) {
      db = { version: 0, stores: new Map() }
      this.databases.set(name, db)
    }
    return db.stores
  }

  /** The next request, on any connection, fails with this error, and its transaction aborts. */
  failNextRequest(error = new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError')) {
    this.failures.push(error)
  }

  takeFailure(): DOMException | undefined {
    return this.failures.shift()
  }

  /** The browser closes every open connection underneath the page, and says so (`close`). */
  closeUnderneath({ silently = false } = {}) {
    for (const db of [...this.connections]) {
      db.closing = true
      db.closed = true
      this.connections.delete(db)
      if (!silently) db.onclose?.()
    }
    this.wake()
  }

  connectionClosed(db: FakeDatabase) {
    this.connections.delete(db)
    this.wake()
  }

  private wake() {
    const waiting = this.closeWaiters
    this.closeWaiters = []
    for (const w of waiting) w()
  }

  private allClosed(name: string): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if ([...this.connections].some(db => db.name === name)) this.closeWaiters.push(check)
        else resolve()
      }
      check()
    })
  }

  open(name: string, version: number) {
    const req = new FakeRequest<FakeDatabase>()
    const run = () => {
      const stored = this.databases.get(name)
      const db = new FakeDatabase(this, name, version)
      this.stores(name)
      req.result = db
      if (!stored || stored.version < version) {
        req.onupgradeneeded?.()
        this.databases.get(name)!.version = version
      }
      this.opened++
      this.connections.add(db)
      req.onsuccess?.()
    }
    later(() => void (this.deleting ?? Promise.resolve()).then(run))
    return req
  }

  deleteDatabase(name: string) {
    const req = new FakeRequest<undefined>()
    this.deleting = (async () => {
      await new Promise(resolve => later(() => resolve(undefined)))
      for (const db of [...this.connections]) if (db.name === name && !db.closing) db.onversionchange?.({ oldVersion: db.version, newVersion: null })
      if ([...this.connections].some(db => db.name === name)) {
        this.blocked++
        req.onblocked?.()
      }
      await this.allClosed(name)
      this.databases.delete(name)
      this.deleting = null
      req.onsuccess?.()
    })()
    return req
  }
}

/** A fresh stand-in on the globals idb.ts reads, IDBKeyRange with it. */
export function installFakeIndexedDB(): FakeIndexedDB {
  const fake = new FakeIndexedDB()
  const g = globalThis as unknown as Record<string, unknown>
  g.indexedDB = fake
  g.IDBKeyRange = { bound: (lower: string, upper: string): KeyRange => ({ lower, upper }) }
  return fake
}
