const DB_NAME = 'drafter'
const STORES = ['media', 'handles'] as const

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
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
