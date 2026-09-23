// What one edit costs on a device holding ~20,000 records: how many records
// the local cache writes, how many of the lists the views render are drawn
// again, and the time each part takes. Two ways side by side:
//
//   before  the whole cache as ONE value, rewritten after every change, and
//           every list drawn afresh from every record (the build before the
//           per-record cache; the engine still writes this way for a storage
//           without readAll/writeChanges)
//   after   one row per record, only what changed written (src/idb.ts), and
//           each list drawn again only when its own kind changed
//           (src/kindlists.ts)
//
// It loads the app's own modules through Vite and runs in memory: no
// IndexedDB, no network, no React. IndexedDB's cost stands in as
// structuredClone of whatever a write hands it — the copy a put() makes on the
// main thread before anything reaches the disk — so the write column is a
// floor; a phone's real write costs more, and more so for 20,000 records than
// for one.
//
//   node scripts/measure-edit-cost.mjs [records=20000] [edits=30]
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const COUNT = Number(process.argv[2] ?? 20_000)
const EDITS = Number(process.argv[3] ?? 30)
const WARMUP = 10
const ME = 'user-1'
const T0 = Date.UTC(2023, 8, 22)
const DAY = 86_400_000

const iso = ms => new Date(ms).toISOString()
const dayKey = n => iso(T0 + n * DAY).slice(0, 10)
const pad = n => String(n).padStart(5, '0')

/** The shape a household's year or three of use takes, scaled to `count`. */
function synthetic(count) {
  const share = { task: 0.25, meal: 0.16, chat: 0.2, message: 0.2, wear: 0.05, journal: 0.05, garment: 0.02, recipe: 0.015, place: 0.015, note: 0.015, event: 0.01, grocery: 0.0075, person: 0.005, outfit: 0.0025 }
  const items = []
  const stamp = n => iso(T0 + n * 60_000)
  let n = 0
  const add = (kind, make) => {
    const total = Math.max(1, Math.round(count * share[kind]))
    for (let i = 0; i < total; i++, n++) items.push({ kind, createdAt: stamp(n), updatedAt: stamp(n), ownerId: ME, ...make(i) })
  }
  add('task', i => ({ id: `task-${pad(i)}`, title: `Task ${i}`, description: '', status: i % 3 ? 'done' : 'todo', priority: 'normal', tags: [] }))
  add('meal', i => ({ id: `meal~${dayKey(Math.floor(i / 3))}~${['breakfast', 'lunch', 'dinner'][i % 3]}~${ME}`, date: dayKey(Math.floor(i / 3)), slot: ['breakfast', 'lunch', 'dinner'][i % 3], title: `Meal ${i}` }))
  add('chat', i => ({ id: `chat~${stamp(i)}~${pad(i)}`, role: i % 2 ? 'drafter' : 'you', text: `Line ${i} of the conversation with the assistant` }))
  add('message', i => ({ id: `message~${stamp(i)}~${pad(i)}`, body: `Line ${i} of the household thread` }))
  add('wear', i => ({ id: `wear~${dayKey(i)}~${pad(i)}`, date: dayKey(i), garmentIds: ['garment-00001', 'garment-00002'] }))
  add('journal', i => ({ id: `journal~${dayKey(i)}~${pad(i)}`, date: dayKey(i), body: `What day ${i} was like` }))
  add('garment', i => ({ id: `garment-${pad(i)}`, name: `Piece ${i}`, type: 'top' }))
  add('recipe', i => ({ id: `recipe-${pad(i)}`, name: `Recipe ${i}`, ingredients: [], tags: [] }))
  add('place', i => ({ id: `place-${pad(i)}`, name: `Place ${i}`, color: '#22d3ee', category: 'restaurant' }))
  add('note', i => ({ id: `note-${pad(i)}`, title: `Note ${i}`, body: '<p>Written down</p>' }))
  add('event', i => ({ id: `event-${pad(i)}`, title: `Event ${i}`, start: iso(T0 + i * DAY), end: iso(T0 + i * DAY + 3_600_000) }))
  add('grocery', i => ({ id: `grocery~${pad(i)}`, weekKey: `2025-W${String((i % 52) + 1).padStart(2, '0')}`, items: [] }))
  add('person', i => ({ id: `person-${pad(i)}`, name: `Person ${i}`, color: '#3b82f6', group: 'family' }))
  add('outfit', i => ({ id: `outfit-${pad(i)}`, garmentIds: ['garment-00001', 'garment-00002'] }))
  return items
}

/** Timers the script fires itself: the engine's debounces never run behind its back. */
const timers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} }

const kv = () => {
  const map = new Map()
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: k => void map.delete(k) }
}

/**
 * What both disks share: how many records the last write handed over, how long
 * copying them took, and a promise for the next write — the engine starts a
 * write once the one before it has settled, a moment after the edit.
 */
function disk() {
  const d = {
    written: 0,
    cloneMs: 0,
    /** @type {((value?: unknown) => void) | null} resolves next() when the write lands */
    landed: null,
    next() {
      return new Promise(resolve => (d.landed = resolve))
    },
    /** Copy what a write hands over, as IndexedDB's put() does, and say so. */
    copy(value, count) {
      const t = performance.now()
      const copy = structuredClone(value)
      d.cloneMs = performance.now() - t
      d.written = count
      d.landed?.()
      return copy
    },
  }
  return d
}

/** The single value, rewritten whole: what a storage without the per-record calls gets. */
function singleValue(items) {
  const d = disk()
  let value = { version: 3, userId: ME, items }
  return {
    disk: d,
    storage: {
      readSnapshot: async () => value,
      writeSnapshot: async record => {
        value = d.copy(record, record.items.length)
      },
      clearAll: async () => {},
      kv: kv(),
    },
  }
}

/** One row per record, as src/idb.ts keeps them. */
function perRecord(items) {
  const d = disk()
  const records = new Map(items.map(i => [i.id, i]))
  return {
    disk: d,
    storage: {
      readAll: async () => ({ version: 3, userId: ME, items: [...records.values()], shadows: [] }),
      writeChanges: async change => {
        const copy = d.copy(change, change.upserts.length + change.deletes.length)
        for (const id of copy.deletes) records.delete(id)
        for (const item of copy.upserts) records.set(item.id, item)
      },
      readSnapshot: async () => undefined,
      writeSnapshot: async () => {
        throw new Error('the per-record cache never writes the single value')
      },
      clearAll: async () => {},
      kv: kv(),
    },
  }
}

const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]

async function run(mode, mods, items) {
  const { createSyncEngine } = mods.engine
  const { LISTS, drawLists } = mods.lists
  const { disk, storage } = mode === 'before' ? singleValue(structuredClone(items)) : perRecord(structuredClone(items))
  // local mode: no rounds, so nothing but the edit itself is timed
  const engine = createSyncEngine({ rpc: null, storage, timers })
  await engine.boot(ME)
  // whatever boot has to write (the per-record cache, read as it was written, has nothing)
  engine.flush()
  await new Promise(resolve => setTimeout(resolve, 0))
  const records = engine.getState().items.length
  const everyList = Object.keys(LISTS).length
  let drawn = mode === 'after' ? drawLists(engine.getState().byKind, ME, null) : null

  const rows = []
  const tasks = engine.getState().byKind.task
  for (let i = 0; i < WARMUP + EDITS; i++) {
    const cur = engine.getState().items.find(x => x.id === tasks[(i * 7919) % tasks.length].id)
    const t0 = performance.now()
    engine.upsert({ ...cur, title: `${cur.title}.`, updatedAt: iso(Date.parse(cur.updatedAt) + 1) })
    const t1 = performance.now()
    // what store.ts derives for the views after a change
    const state = engine.getState()
    let rebuilt
    if (mode === 'before') {
      for (const spec of Object.values(LISTS)) spec.draw(state.items.filter(x => x.kind === spec.kind), ME)
      rebuilt = everyList
    } else {
      drawn = drawLists(state.byKind, ME, drawn)
      rebuilt = drawn.rebuilt.length
    }
    state.items.filter(x => !x.ownerId || x.ownerId === ME)
    const t2 = performance.now()
    // the write the debounce would start: flushed now, and waited for
    const landed = disk.next()
    engine.flush()
    let timer
    const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${mode}: an edit wrote nothing`)), 5_000)))
    await Promise.race([landed, late]).finally(() => clearTimeout(timer))
    if (i >= WARMUP) rows.push({ engine: t1 - t0, lists: t2 - t1, write: disk.cloneMs, total: t2 - t0 + disk.cloneMs, written: disk.written, rebuilt })
  }
  return {
    records,
    written: median(rows.map(r => r.written)),
    rebuilt: median(rows.map(r => r.rebuilt)),
    of: everyList,
    engine: median(rows.map(r => r.engine)),
    lists: median(rows.map(r => r.lists)),
    write: median(rows.map(r => r.write)),
    total: median(rows.map(r => r.total)),
  }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } })
try {
  const mods = { engine: await server.ssrLoadModule('/src/syncengine.ts'), lists: await server.ssrLoadModule('/src/kindlists.ts') }
  const items = synthetic(COUNT)
  const before = await run('before', mods, items)
  const after = await run('after', mods, items)
  const ms = v => `${v.toFixed(2)} ms`
  const table = [
    ['', 'before', 'after'],
    ['records on the device', String(before.records), String(after.records)],
    ['records written per edit', String(before.written), String(after.written)],
    ['lists drawn again per edit', `${before.rebuilt} of ${before.of}`, `${after.rebuilt} of ${after.of}`],
    ['engine (the edit itself)', ms(before.engine), ms(after.engine)],
    ['lists', ms(before.lists), ms(after.lists)],
    ['cache write (structuredClone)', ms(before.write), ms(after.write)],
    ['one edit, all told', ms(before.total), ms(after.total)],
  ]
  const width = table[0].map((_, c) => Math.max(...table.map(r => r[c].length)))
  console.log(`One edit of a task, median of ${EDITS} after ${WARMUP} to warm up (node ${process.version}):\n`)
  for (const r of table) console.log(r.map((cell, c) => (c === 0 ? cell.padEnd(width[c]) : cell.padStart(width[c]))).join('   '))
} finally {
  await server.close()
}
