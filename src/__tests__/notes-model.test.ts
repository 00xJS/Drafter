import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blankNote, createNoteSaver, draftOf, editedLabel, hasNoteText, matchesQuery, noteToSave, notesIndex, UNTITLED } from '../components/notes/model'
import { sortNotes } from '../store'
import { Note, Project } from '../types'
import { fmtDate } from '../utils'
import { FakeServer, device, idle, ready } from './sync-fakes'

// Tasks → Notes: the rules behind the list and a note's screen — the order,
// the search, when a note is saved and what it is called, and that Delete is a
// tombstone Trash can restore. The components only draw these.

const T0 = '2026-09-01T09:00:00.000Z'
const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T09:00:00.000Z`

function note(id: string, over: Partial<Note> = {}): Note {
  return { kind: 'note', id, title: id, body: `<p>${id} text</p>`, createdAt: T0, updatedAt: T0, ...over }
}

function project(id: string, over: Partial<Project> = {}): Project {
  return { kind: 'project', id, name: id, color: '#f97316', status: 'active', createdAt: T0, updatedAt: T0, ...over }
}

describe('notesIndex: one list of notes and project pads', () => {
  const notes = [
    note('old', { updatedAt: day(2) }),
    note('pinned-old', { pinned: true, updatedAt: day(3) }),
    note('new', { updatedAt: day(11) }),
    note('pinned-new', { pinned: true, updatedAt: day(10) }),
    note('trashed', { updatedAt: day(12), deletedAt: day(12) }),
  ]
  const projects = [
    project('pad-mid', { name: 'Hall', notesHtml: '<p>Sage for the hall</p>', updatedAt: day(5) }),
    // a legacy Markdown pad counts, read through the same conversion the pad uses
    project('pad-newest', { name: 'Garden', notes: '# Beds\n- tomatoes', updatedAt: day(12) }),
    project('pad-photo', { name: 'Porch', notesHtml: '<p><img data-media="m1" alt=""></p>', updatedAt: day(1) }),
    project('pad-blank', { name: 'Garage', notesHtml: '<p><br></p>', updatedAt: day(12) }),
    project('pad-none', { name: 'Loft', updatedAt: day(12) }),
    project('pad-archived', { name: 'Old', status: 'archived', notesHtml: '<p>kept</p>', updatedAt: day(12) }),
  ]

  it('puts pinned notes first, then the other notes and every non-empty pad together, newest first', () => {
    expect(notesIndex(notes, projects).map(e => e.key)).toEqual(['note:pinned-new', 'note:pinned-old', 'pad:pad-newest', 'note:new', 'pad:pad-mid', 'note:old', 'pad:pad-photo'])
  })

  it('orders the notes exactly as sortNotes (store.notes) does', () => {
    expect(notesIndex(notes, []).map(e => e.id)).toEqual(sortNotes(notes.filter(n => !n.deletedAt)).map(n => n.id))
  })

  it('breaks a tie between a note and a pad in the note’s favour, and between two pads by id', () => {
    const list = notesIndex([note('n', { updatedAt: day(4) })], [project('p-b', { notesHtml: '<p>b</p>', updatedAt: day(4) }), project('p-a', { notesHtml: '<p>a</p>', updatedAt: day(4) })])
    expect(list.map(e => e.key)).toEqual(['note:n', 'pad:p-a', 'pad:p-b'])
  })

  it('names a note by its title or "Untitled note", and a pad by its project, with the text on one line', () => {
    const [n, p] = notesIndex([note('n', { title: '', body: '<p>text only</p>', updatedAt: day(4) })], [project('p', { name: 'Hall', notesHtml: '<h2>Paint</h2><p>Sage</p>', updatedAt: day(3) })])
    expect(n).toEqual({ key: 'note:n', kind: 'note', id: 'n', title: UNTITLED, text: 'text only', updatedAt: day(4), pinned: false, projectId: undefined })
    expect(p).toEqual({ key: 'pad:p', kind: 'pad', id: 'p', title: 'Hall', text: 'Paint Sage', updatedAt: day(3), pinned: false, projectId: 'p' })
  })

  it('carries what a note is about', () => {
    expect(notesIndex([note('n', { projectId: 'p1' })], [])[0].projectId).toBe('p1')
  })
})

describe('searching the list', () => {
  const notes = [note('a', { title: 'Paint colours', body: '<p>Sage for the hall</p>', updatedAt: day(9) }), note('b', { title: 'Gift ideas', body: '<p>Books for Sam</p>', updatedAt: day(8) })]
  const projects = [project('p', { name: 'Garden', notesHtml: '<p>Tomatoes and sage</p>', updatedAt: day(7) })]
  const keys = (q: string) => notesIndex(notes, projects, q).map(e => e.key)

  it('matches every word, in the title or the text, in any case, and keeps the list order', () => {
    expect(keys('')).toEqual(['note:a', 'note:b', 'pad:p'])
    expect(keys('   ')).toEqual(['note:a', 'note:b', 'pad:p'])
    expect(keys('SAGE')).toEqual(['note:a', 'pad:p'])
    expect(keys('gift')).toEqual(['note:b'])
    expect(keys('sage hall')).toEqual(['note:a'])
    expect(keys('  books   sam ')).toEqual(['note:b'])
    // a pad is found by its project's name as well as by its text
    expect(keys('garden')).toEqual(['pad:p'])
    expect(keys('zebra')).toEqual([])
  })

  it('reads fields as one text, so a word may be in the title and another in the text', () => {
    expect(matchesQuery('paint sage', 'Paint colours', 'Sage for the hall')).toBe(true)
    expect(matchesQuery('paint zebra', 'Paint colours', 'Sage for the hall')).toBe(false)
  })
})

describe('when a note is saved, and as what', () => {
  const base = blankNote('n1', T0)

  it('starts a new note blank, with nothing but its id and when', () => {
    expect(base).toEqual({ kind: 'note', id: 'n1', title: '', body: '', createdAt: T0, updatedAt: T0 })
  })

  it('never saves a note with neither a title nor any text', () => {
    for (const [title, body] of [
      ['', ''],
      ['   ', ''],
      ['', '<p><br></p>'],
      ['', '<p>   </p>'],
      [' ', '<h2></h2><p><br></p>'],
    ]) {
      expect(hasNoteText(body), body).toBe(false)
      expect(noteToSave(base, { title, body }), JSON.stringify([title, body])).toBeNull()
    }
  })

  it('saves text with no title as "Untitled note"', () => {
    expect(noteToSave(base, { title: '  ', body: '<p>Sage for the hall</p>' })).toMatchObject({ title: UNTITLED, body: '<p>Sage for the hall</p>' })
    // a photo on its own is something to keep too
    expect(noteToSave(base, { title: '', body: '<p><img data-media="m1" alt=""></p>' })).toMatchObject({ title: UNTITLED })
  })

  it('saves a title with no text, trimmed', () => {
    expect(noteToSave(base, { title: '  Hall paint  ', body: '' })).toMatchObject({ title: 'Hall paint', body: '' })
  })

  it('keeps who made it and when, clears a false pin or an empty About, and stamps it newer than its base', () => {
    const owned = note('n2', { ownerId: 'user-1', createdAt: T0, updatedAt: day(5), pinned: true, projectId: 'p1' })
    const next = noteToSave(owned, { title: 'Hall', body: '<p>x</p>', pinned: false, projectId: '' })!
    expect(next).toMatchObject({ kind: 'note', id: 'n2', ownerId: 'user-1', createdAt: T0, pinned: undefined, projectId: undefined })
    expect(next.updatedAt > owned.updatedAt).toBe(true)
    expect(noteToSave(owned, { title: 'Hall', body: '', pinned: true, projectId: 'p2' })).toMatchObject({ pinned: true, projectId: 'p2' })
  })

  it('reads "Untitled note" back as an empty title, so saving it again keeps it untitled', () => {
    expect(draftOf(note('n', { title: UNTITLED }))).toMatchObject({ title: '' })
    expect(draftOf(note('n', { title: 'Hall', pinned: true, projectId: 'p' }))).toEqual({ title: 'Hall', body: '<p>n text</p>', projectId: 'p', pinned: true })
    expect(noteToSave(note('n', { title: UNTITLED }), draftOf(note('n', { title: UNTITLED })))).toMatchObject({ title: UNTITLED })
  })
})

describe('editedLabel', () => {
  it('says how long ago, then the date', () => {
    const now = Date.parse('2026-09-12T12:00:00.000Z')
    expect(editedLabel('2026-09-12T11:59:40.000Z', now)).toBe('just now')
    // a stamp a little ahead of this device's clock is still "just now"
    expect(editedLabel('2026-09-12T12:00:30.000Z', now)).toBe('just now')
    expect(editedLabel('2026-09-12T11:30:00.000Z', now)).toBe('30m ago')
    expect(editedLabel('2026-09-12T09:00:00.000Z', now)).toBe('3h ago')
    expect(editedLabel('2026-09-10T12:00:00.000Z', now)).toBe('2d ago')
    expect(editedLabel('2026-08-01T12:00:00.000Z', now)).toBe(fmtDate('2026-08-01T12:00:00.000Z'))
  })
})

describe('createNoteSaver: the autosave behind a note’s screen', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-12T10:00:00.000Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A saver over an in-memory store, recording every save and delete. */
  function harness(opened: Note, inStore = false) {
    const store = new Map<string, Note>(inStore ? [[opened.id, opened]] : [])
    const saves: Note[] = []
    const removed: string[] = []
    const saver = createNoteSaver({
      note: opened,
      stored: () => store.get(opened.id),
      save: n => {
        saves.push(n)
        store.set(n.id, n)
      },
      remove: id => {
        removed.push(id)
        store.delete(id)
      },
    })
    return { saver, saves, removed, store }
  }

  it('never saves a new note that has neither a title nor any text: not on a pause, a pin, leaving or Delete', async () => {
    const { saver, saves, removed } = harness(blankNote('fresh', T0))
    saver.change({ title: '', body: '' })
    saver.change({ title: '   ', body: '<p><br></p>' })
    await vi.advanceTimersByTimeAsync(5000)
    saver.change({ title: '', body: '<p> </p>', pinned: true })
    expect(saver.flush()).toBeNull()
    saver.remove()
    expect(saves).toEqual([])
    expect(removed).toEqual([])
    expect(saver.saved()).toBe(false)
  })

  it('saves once, after a pause, as soon as there is some text, as "Untitled note"', async () => {
    const { saver, saves } = harness(blankNote('fresh', T0))
    saver.change({ title: '', body: '<p>S</p>' })
    await vi.advanceTimersByTimeAsync(400)
    saver.change({ title: '', body: '<p>Sage</p>' })
    expect(saver.pending()).toBe(true)
    await vi.advanceTimersByTimeAsync(799)
    expect(saves).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ kind: 'note', id: 'fresh', title: UNTITLED, body: '<p>Sage</p>', createdAt: T0 })
    expect(saver.pending()).toBe(false)
    expect(saver.saved()).toBe(true)
  })

  it('keeps each save strictly newer than the last, even before the store has caught up', () => {
    const opened = note('n', { updatedAt: '2026-09-12T10:00:00.000Z' })
    const saves: Note[] = []
    const saver = createNoteSaver({ note: opened, stored: () => opened, save: n => void saves.push(n), remove: () => {} })
    saver.change({ title: 'a', body: '' })
    saver.flush()
    saver.change({ title: 'ab', body: '' })
    saver.flush()
    expect(saves.map(n => n.title)).toEqual(['a', 'ab'])
    expect(saves[0].updatedAt > opened.updatedAt).toBe(true)
    expect(saves[1].updatedAt > saves[0].updatedAt).toBe(true)
  })

  it('writes nothing for a change that changes nothing, or for a note emptied of everything', () => {
    const { saver, saves } = harness(note('n', { title: 'Hall', body: '<p>Sage</p>' }), true)
    saver.change({ title: 'Hall', body: '<p>Sage</p>', pinned: false })
    expect(saver.flush()).toBeNull()
    saver.change({ title: '', body: '<p><br></p>' })
    expect(saver.flush()).toBeNull()
    expect(saves).toEqual([])
  })

  it('Delete saves what was just typed, then tombstones it, and nothing saves after', async () => {
    const { saver, saves, removed } = harness(note('n', { title: 'Hall' }), true)
    saver.change({ title: 'Hall paint', body: '<p>Sage</p>' })
    saver.remove()
    expect(saves.map(n => n.title)).toEqual(['Hall paint'])
    expect(removed).toEqual(['n'])
    saver.change({ title: 'again', body: '' })
    saver.flush()
    await vi.advanceTimersByTimeAsync(5000)
    saver.remove()
    expect(saves).toHaveLength(1)
    expect(removed).toEqual(['n'])
  })

  it('stands down for good when the note is deleted on another device', async () => {
    const { saver, saves } = harness(note('n'), true)
    saver.change({ title: 'typed here', body: '' })
    saver.abandon()
    await vi.advanceTimersByTimeAsync(5000)
    saver.flush()
    expect(saves).toEqual([])
  })
})

describe('Delete on a note is a tombstone Trash can restore', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-12T10:00:00.000Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('through the real engine: saved, deleted with its last words, pushed as deleted, and restored whole', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d)
    // what store.notes holds: live notes only
    const live = () => {
      const n = d.item<Note>('n-hall')
      return n && !n.deletedAt ? n : undefined
    }
    const saver = createNoteSaver({ note: blankNote('n-hall', new Date().toISOString()), stored: live, save: n => d.engine.upsert(n), remove: id => d.engine.remove(id) })

    saver.change({ title: '', body: '<p>Sage for the hall</p>' })
    await vi.advanceTimersByTimeAsync(800)
    expect(live()).toMatchObject({ kind: 'note', title: UNTITLED, body: '<p>Sage for the hall</p>' })

    saver.change({ title: 'Hall', body: '<p>Sage for the hall, white ceiling</p>' })
    saver.remove()
    expect(live()).toBeUndefined()
    const gone = d.item<Note>('n-hall')!
    expect(gone).toMatchObject({ title: 'Hall', body: '<p>Sage for the hall, white ceiling</p>' })
    expect(gone.deletedAt).toBeTruthy()

    await vi.advanceTimersByTimeAsync(2000)
    await idle(d)
    expect(server.row<Note>('n-hall')).toMatchObject({ kind: 'note', title: 'Hall' })
    expect(server.row<Note>('n-hall')!.deletedAt).toBeTruthy()

    d.engine.restore(['n-hall'])
    expect(live()).toMatchObject({ title: 'Hall', body: '<p>Sage for the hall, white ceiling</p>' })
  })
})
