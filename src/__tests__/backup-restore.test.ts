import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBackup } from '../../netlify/functions/lib/backup.mjs'
import { CannotDecrypt, unwrapSnapshot } from '../backupcrypto'
import { migrateStored, sanitizeItem } from '../schema'
import type { Item, Task } from '../types'
import { FakeServer, device, idle, ready, task } from './sync-fakes'
import { pageResponse } from './postgrest'

// A backup nobody has restored is a hope. This restores one, end to end, with
// the code each step really runs:
//
//   runBackup (the nightly pass: every live record read, one snapshot per
//   account, encrypted under BACKUP_PASSPHRASE and uploaded)
//   → unwrapSnapshot (Admin → Backups → Read it, in the browser, with the
//   passphrase typed there)
//   → the readable copy Admin saves, read the way Settings → Data → Import a
//   file reads it (migrateStored)
//   → importItems (the engine's own import) on a device, and its next round
//   to the server.
//
// Only the host and the network are stand-ins: the storage bucket is a Map,
// and sync_posts is sync-fakes' FakeServer.

// the browser half uses WebCrypto; node's is the same API
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

const SUPABASE = 'https://db.example.test'
const PASSPHRASE = 'a passphrase the host holds'
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const NIGHT = new Date('2026-09-22T00:00:00.000Z')
const T0 = '2026-09-01T09:00:00.000Z'

/** Everything A has: the one project, work, a note, a person and a day of the journal. */
const MINE: Item[] = [
  { kind: 'project', id: 'home', name: 'Home', status: 'active', createdAt: T0, updatedAt: T0 } as Item,
  task('t-bins', { title: 'Put the bins out', projectId: 'home', dueAt: '2026-09-23T07:00:00.000Z' }),
  task('t-fence', { title: 'Paint the fence', status: 'doing', projectId: 'home', tags: ['garden'] }),
  { kind: 'note', id: 'n-paint', title: 'Paint colours', body: '<p>Sage green for the fence</p>', createdAt: T0, updatedAt: T0 } as Item,
  { kind: 'person', id: 'p-mum', name: 'Mum', createdAt: T0, updatedAt: T0 } as Item,
  { kind: 'journal', id: 'journal~2026-09-20', date: '2026-09-20', body: 'the private bit', createdAt: T0, updatedAt: T0 } as Item,
]
/** B, in the same household: their own journal is theirs alone, and never in A's snapshot. */
const THEIRS: Item[] = [
  task('t-b-errand', { title: 'Collect the parcel' }),
  { kind: 'journal', id: 'journal~2026-09-20~b', date: '2026-09-20', body: 'what B wrote', createdAt: T0, updatedAt: T0 } as Item,
]

type Row = { id: string; user_id: string; data: Item }
const rows = (): Row[] => [...MINE.map(data => ({ id: data.id, user_id: A, data })), ...THEIRS.map(data => ({ id: data.id, user_id: B, data }))]

/** What landed in the bucket, by path. */
let uploads: Map<string, unknown>

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('BACKUP_PASSPHRASE', PASSPHRASE)
  uploads = new Map()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(SUPABASE, '')
      const method = init?.method ?? 'GET'
      // every live record, a page at a time as PostgREST answers restAll
      if (method === 'GET' && url.startsWith('/rest/v1/posts?select=id,data,user_id&deleted=is.false')) return pageResponse(url, rows())
      if (method === 'GET' && url.startsWith('/rest/v1/posts?select=id,user_id,data&kind=eq.garment')) return new Response('[]', { headers: { 'content-range': '*/0' } })
      if (method === 'POST' && url.startsWith('/storage/v1/object/media/backups/')) {
        uploads.set(url.slice('/storage/v1/object/media/'.length), JSON.parse(String(init?.body)))
        return Response.json({ Key: url })
      }
      if (method === 'POST' && url === '/storage/v1/object/list/media') return Response.json([])
      if (method === 'DELETE') return new Response(null, { status: 204, headers: { 'content-range': '*/0' } })
      throw new Error(`unexpected ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const byId = (items: readonly Item[]) => [...items].sort((x, y) => x.id.localeCompare(y.id))
const clean = (items: readonly Item[]) => items.map(i => sanitizeItem(i)!)

/** Last night's snapshot of A, as Admin → Backups reads it and saves it, parsed the way Import a file parses it. */
async function lastNightsFile(passphrase = PASSPHRASE): Promise<Item[]> {
  const report = await runBackup(NIGHT)
  expect(report.encrypted).toBe(true)
  expect(report.failures).toEqual([])
  const stored = uploads.get(`backups/${A}/2026-09-22.json`)
  // nothing readable in the bucket: not the journal, not a title
  expect(JSON.stringify(stored)).not.toMatch(/the private bit|Put the bins out|Sage green/)
  const snapshot = await unwrapSnapshot(stored, passphrase)
  // "Save the readable copy" writes exactly this; "Import a file" reads it exactly so
  const readableCopy = JSON.stringify(snapshot, null, 2)
  return migrateStored(JSON.parse(readableCopy))!
}

describe('restoring a nightly backup', () => {
  it('brings every record back into an empty account, exactly, and the server has them after one round', async () => {
    // the fixtures are records the app itself would keep
    expect(clean(MINE).every(Boolean)).toBe(true)
    const incoming = await lastNightsFile()
    // A's own records only: B's journal went into B's snapshot, not this one
    expect(incoming.map(i => i.id).sort()).toEqual(MINE.map(i => i.id).sort())

    vi.useFakeTimers({ now: new Date('2026-09-22T12:00:00.000Z') })
    const server = new FakeServer()
    server.caller = A
    const d = device(server)
    await ready(d, A)
    expect(d.engine.getState().items).toEqual([])

    expect(d.engine.importItems(incoming)).toEqual({ added: MINE.length, updated: 0, unchanged: 0, metricsRefreshed: 0 })
    expect(byId(d.engine.getState().items)).toEqual(byId(clean(MINE)))

    await vi.advanceTimersByTimeAsync(2000)
    await idle(d)
    for (const item of clean(MINE)) expect(server.row(item.id), item.id).toEqual(item)
    expect(d.engine.getState().syncInfo.pending).toBe(0)

    // the same file again changes nothing
    expect(d.engine.importItems(incoming)).toEqual({ added: 0, updated: 0, unchanged: MINE.length, metricsRefreshed: 0 })
  })

  it('into an account that has moved on: what went missing comes back, and what was edited since keeps its newer version', async () => {
    const incoming = await lastNightsFile()

    vi.useFakeTimers({ now: new Date('2026-09-22T12:00:00.000Z') })
    const server = new FakeServer()
    server.caller = A
    // since the snapshot: the fence was finished, and everything else was lost
    const finished = task('t-fence', { title: 'Paint the fence', status: 'done', projectId: 'home', tags: ['garden'], updatedAt: '2026-09-22T08:00:00.000Z' })
    server.seed(finished)
    const d = device(server)
    await ready(d, A)

    expect(d.engine.importItems(incoming)).toEqual({ added: MINE.length - 1, updated: 0, unchanged: 1, metricsRefreshed: 0 })
    expect(d.item<Task>('t-fence')).toMatchObject({ status: 'done', updatedAt: '2026-09-22T08:00:00.000Z' })
    expect(d.item('journal~2026-09-20')).toMatchObject({ body: 'the private bit' })
    await vi.advanceTimersByTimeAsync(2000)
    await idle(d)
    expect(server.row<Task>('t-fence')!.status).toBe('done')
    expect(server.row('n-paint')).toEqual(sanitizeItem(MINE[3]))
  })

  it('opens with nothing but the right passphrase', async () => {
    await expect(lastNightsFile('not the passphrase')).rejects.toBeInstanceOf(CannotDecrypt)
  })
})
