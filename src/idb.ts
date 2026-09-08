const DB_NAME = 'drafter'
// 'posts' arrived in v2 (the local cache moved out of localStorage's 5MB quota)
const STORES = ['media', 'handles', 'posts'] as const

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      for (const s of STORES) {
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
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

/**
 * Remove every trace of the signed-in person from this device: the cached
 * records, the photos, and every drafter:* preference. Signing out has to do
 * this — otherwise the whole planner stays readable in DevTools on a shared,
 * sold or stolen device, and the next account to sign in inherits it.
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
      if (k && k.startsWith('drafter:')) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* storage may be unavailable; carry on and still drop the database */
  }
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
