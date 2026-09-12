import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newerStamp } from '../itemops'
import { mediaIdsIn, sanitizeHtml } from '../richtext'
import { KNOWN_KINDS, migrateStored, sanitizeItem, sanitizeNote } from '../schema'
import { sortNotes } from '../store'
import { purgeTombstone } from '../sync'
import { recordLabel } from '../syncengine'
import { Note } from '../types'
import { FakeServer, device, idle, ready, type Device } from './sync-fakes'

// Notes are their own records (kind 'note'): several per household, each a
// title and the same sanitized HTML a project pad stores. These pin the model —
// what the sanitizer keeps and drops, how the list sorts — and that a note goes
// through the sync engine exactly as a task does.

// The real sanitizeHtml, watched: vitest runs in node, where it has no DOMParser
// and passes HTML through, so what these can prove is that a note's body goes
// through the one function the project pad's editor uses, not a copy of its rules.
vi.mock(import('../richtext'), async importOriginal => {
  const real = await importOriginal()
  return { ...real, sanitizeHtml: vi.fn(real.sanitizeHtml) }
})

const T0 = '2026-09-12T09:00:00.000Z'

/** What a project pad stores today: headings, a checklist, a photo by media id. */
const PAD_HTML = '<h2>Hall</h2><ul class="checklist"><li><input type="checkbox" checked="">Sage</li></ul><p><img data-media="m-swatch" alt="swatch"></p>'

function note(over: Partial<Note> = {}): Note {
  return { kind: 'note', id: 'note-1', title: 'Paint colours', body: PAD_HTML, projectId: 'p1', pinned: true, createdAt: T0, updatedAt: T0, ...over }
}

describe('sanitizeNote', () => {
  it('keeps a full note exactly, through sanitizeItem, a stored payload and JSON', () => {
    const full = note()
    expect(sanitizeNote(full)).toEqual(full)
    expect(sanitizeItem(full)).toEqual(full)
    expect(migrateStored({ version: 3, items: [full] })).toEqual([full])
    expect(sanitizeItem(JSON.parse(JSON.stringify(sanitizeItem(full))))).toEqual(full)
    // photos are referenced by media id, as on a project pad
    expect(mediaIdsIn(sanitizeNote(full)!.body)).toEqual(['m-swatch'])
  })

  it('is a kind the server accepts, with a sanitizer of its own (not a blank task, not dropped as unknown)', () => {
    expect(KNOWN_KINDS.has('note')).toBe(true)
    expect(sanitizeItem({ kind: 'note', id: 'n', title: 'Plan' })).toMatchObject({ kind: 'note', id: 'n', title: 'Plan', body: '' })
  })

  it('drops what is not a note', () => {
    for (const junk of [null, undefined, 'note', 42, [], {}, { kind: 'note' }, { kind: 'note', title: 'No id' }, { kind: 'note', id: 'n1' }, { kind: 'note', id: 'n1', title: '   ', body: '' }]) {
      expect(sanitizeNote(junk), JSON.stringify(junk)).toBeNull()
    }
  })

  it('repairs or drops each bad field and keeps no stray ones', () => {
    const n = sanitizeNote({
      kind: 'note',
      id: 'n2',
      title: '  Hall  ',
      body: { html: '<p>x</p>' },
      projectId: '   ',
      pinned: 'yes',
      createdAt: 'never',
      updatedAt: 'soon',
      deletedAt: 'nope',
      purged: 'true',
      ownerId: '',
      colour: 'red',
    })
    expect(n).toEqual({ kind: 'note', id: 'n2', title: 'Hall', body: '', createdAt: expect.any(String), updatedAt: expect.any(String) })
    expect(Number.isNaN(Date.parse(n!.createdAt))).toBe(false)
    expect(sanitizeNote({ kind: 'note', id: 'n3', title: 'Owned', ownerId: 'user-1', pinned: false })).toMatchObject({ ownerId: 'user-1', pinned: undefined })
  })

  it('is a title or some text: either alone is a note', () => {
    expect(sanitizeNote({ kind: 'note', id: 'n4', title: '', body: '<p>Only text so far</p>' })).toMatchObject({ title: '', body: '<p>Only text so far</p>' })
    expect(sanitizeNote({ kind: 'note', id: 'n5', title: 'Only a title' })).toMatchObject({ title: 'Only a title', body: '' })
  })

  it('sanitizes the body with the function the project pad uses', () => {
    const hostile = '<p onclick="steal()">Hi</p><script>alert(1)</script><img src="https://evil.test/x.png"><a href="javascript:alert(1)">x</a>'
    vi.mocked(sanitizeHtml).mockClear()
    const n = sanitizeNote({ kind: 'note', id: 'n6', title: 'Links', body: hostile })!
    expect(sanitizeHtml).toHaveBeenCalledWith(hostile)
    expect(n.body).toBe(sanitizeHtml(hostile))
    // ...and the pad's editor sanitizes with that same export, wherever it lives after a split
    const components = fileURLToPath(new URL('../components/', import.meta.url))
    const editors = (readdirSync(components, { recursive: true }) as string[])
      .filter(f => /\.tsx?$/.test(f))
      .filter(f => /import \{[^}]*\bsanitizeHtml\b[^}]*\} from '(\.\.\/)+richtext'/.test(readFileSync(components + f, 'utf8')))
    expect(editors.length, 'a component that edits rich notes imports sanitizeHtml from src/richtext.ts').toBeGreaterThan(0)
  })

  it('accepts a content-free tombstone with an empty title, as places do', () => {
    const now = '2026-09-12T10:00:00.000Z'
    expect(sanitizeItem(purgeTombstone('note', 'note-1', now))).toEqual({ kind: 'note', id: 'note-1', title: '', body: '', createdAt: now, updatedAt: now, deletedAt: now, purged: true })
    expect(sanitizeNote({ kind: 'note', id: 'note-1', deletedAt: now })).toMatchObject({ id: 'note-1', title: '', body: '', deletedAt: now })
    // a note in the Trash keeps its content, so Restore brings it all back
    expect(sanitizeNote(note({ deletedAt: now }))).toEqual(note({ deletedAt: now }))
  })

  it('reads as its title in a toast or a Settings row', () => {
    expect(recordLabel(note())).toBe('Paint colours')
    expect(recordLabel(note({ title: '' }))).toBe('Untitled note')
  })
})

describe('sortNotes: the Notes list order', () => {
  it('puts pinned notes first, then the most recently edited, and breaks ties by id', () => {
    const list = [
      note({ id: 'old', pinned: undefined, updatedAt: '2026-09-01T00:00:00.000Z' }),
      note({ id: 'pinned-old', pinned: true, updatedAt: '2026-09-02T00:00:00.000Z' }),
      note({ id: 'new', pinned: undefined, updatedAt: '2026-09-11T00:00:00.000Z' }),
      note({ id: 'pinned-new', pinned: true, updatedAt: '2026-09-10T00:00:00.000Z' }),
      note({ id: 'b-tie', pinned: undefined, updatedAt: '2026-09-05T00:00:00.000Z' }),
      note({ id: 'a-tie', pinned: undefined, updatedAt: '2026-09-05T00:00:00.000Z' }),
    ]
    expect(sortNotes(list).map(n => n.id)).toEqual(['pinned-new', 'pinned-old', 'new', 'a-tie', 'b-tie', 'old'])
    // a copy: the store's array is never sorted in place
    expect(list[0].id).toBe('old')
  })
})

describe('a note syncs like a task', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const editNote = (d: Device, over: Partial<Note>) => {
    const cur = d.item<Note>('note-1')!
    d.engine.upsert({ ...cur, ...over, updatedAt: newerStamp(cur.updatedAt) })
  }

  it('is pushed, reaches another device, and keeps both devices’ edits field by field', async () => {
    const server = new FakeServer()
    const a = device(server)
    const b = device(server)
    await ready(a)
    await ready(b)

    a.engine.upsert(note({ pinned: undefined, body: '<p>Sage for the hall</p>', createdAt: new Date().toISOString(), updatedAt: newerStamp() }))
    await vi.advanceTimersByTimeAsync(2000)
    await idle(a)
    expect(server.row<Note>('note-1')).toMatchObject({ kind: 'note', title: 'Paint colours', body: '<p>Sage for the hall</p>', projectId: 'p1' })
    expect(a.engine.inspect().dirty).toEqual([])
    expect(a.engine.getState().syncInfo.pending).toBe(0)

    await b.engine.sync()
    expect(b.item<Note>('note-1')).toMatchObject({ kind: 'note', title: 'Paint colours', ownerId: 'user-1' })

    // the title on one device, the text and the pin on the other
    editNote(a, { title: 'Hall paint' })
    vi.setSystemTime(Date.now() + 1000)
    editNote(b, { body: '<p>Sage for the hall, white for the ceiling</p>', pinned: true })
    await b.engine.sync()
    await a.engine.sync()
    await b.engine.sync()
    for (const n of [server.row<Note>('note-1')!, a.item<Note>('note-1')!, b.item<Note>('note-1')!]) {
      expect(n).toMatchObject({ title: 'Hall paint', body: '<p>Sage for the hall, white for the ceiling</p>', pinned: true })
    }
    expect(a.engine.inspect().dirty).toEqual([])
    expect(b.engine.inspect().dirty).toEqual([])
  })

  it('Delete forever leaves a content-free note on the server and on every device', async () => {
    const server = new FakeServer()
    server.seed(note())
    const a = device(server)
    const b = device(server)
    await ready(a)
    await ready(b)
    expect(await a.engine.purge(['note-1'])).toBe(true)
    expect(server.row<Note>('note-1')).toMatchObject({ kind: 'note', purged: true, title: '', body: '' })
    await b.engine.sync()
    expect(b.item<Note>('note-1')).toMatchObject({ kind: 'note', purged: true, title: '', body: '' })
    expect(b.item<Note>('note-1')!.deletedAt).toBeTruthy()
  })
})
