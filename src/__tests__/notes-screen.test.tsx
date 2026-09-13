import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotePane } from '../components/notes/NotePane'
import { NotesIndex } from '../components/notes/NotesIndex'
import { blankNote, UNTITLED } from '../components/notes/model'
import { NotesView } from '../components/NotesView'
import { Note, Project } from '../types'

// Tasks → Notes once the shell passes `notes`: the list of notes and pads, and
// a note's screen. A first render, before any effect (vitest runs in node);
// what happens on a keystroke is pinned in notes-model.test.ts.

const NOW = '2026-09-12T12:00:00.000Z'
const T0 = '2026-09-01T09:00:00.000Z'

function project(id: string, over: Partial<Project> = {}): Project {
  return { kind: 'project', id, name: id, color: '#f97316', status: 'active', createdAt: T0, updatedAt: T0, ...over }
}

function note(id: string, title: string, over: Partial<Note> = {}): Note {
  return { kind: 'note', id, title, body: '', createdAt: T0, updatedAt: T0, ...over }
}

const PROJECTS = [
  project('p-hall', { name: 'Hall', emoji: '🏡', notesHtml: '<h2>Paint</h2><p>Sage for the hall</p>', updatedAt: '2026-09-12T09:00:00.000Z' }),
  project('p-garden', { name: 'Garden', notes: '# Beds\n- tomatoes', updatedAt: '2026-09-11T09:00:00.000Z' }),
  project('p-garage', { name: 'Garage' }),
  project('p-archived', { name: 'Old', status: 'archived', notesHtml: '<p>kept</p>' }),
]

const NOTES = [
  note('n-paint', 'Paint colours', { pinned: true, projectId: 'p-hall', body: '<p>Sage for the hall, white for the ceiling</p>', updatedAt: '2026-09-10T12:00:00.000Z' }),
  note('n-gifts', 'Gift ideas', { body: '<p>Books for Sam</p>', updatedAt: '2026-09-12T11:30:00.000Z' }),
  note('n-untitled', UNTITLED, { body: '<p>A line with no name</p>', updatedAt: '2026-09-01T12:00:00.000Z' }),
]

const noop = () => {}
const shell = { getLatest: () => undefined, onSave: noop, onSelectProject: noop, onBack: noop, onCreateTask: noop }

/** The row titles, in the order the list draws them. */
const rowTitles = (html: string) => [...html.matchAll(/class="note-row-title">([^<]*)</g)].map(m => m[1])

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW) })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the Notes list, with notes passed', () => {
  const html = () => renderToStaticMarkup(<NotesView projects={PROJECTS} notes={NOTES} onSaveNote={noop} onDeleteNote={noop} {...shell} />)

  it('lists pinned notes, then notes and non-empty pads by when they were edited', () => {
    expect(rowTitles(html())).toEqual(['Paint colours', 'Gift ideas', '🏡 Hall', 'Garden', UNTITLED])
    // an empty pad and an archived project's pad stay out
    expect(html()).not.toContain('Garage')
    expect(html()).not.toContain('>Old<')
  })

  it('draws each entry as a real button with an excerpt and when it was edited', () => {
    const out = html()
    expect(out.match(/<button type="button" class="note-row( note-row-pad)?">/g)).toHaveLength(5)
    expect(out).toContain('<span class="note-row-excerpt">Sage for the hall, white for the ceiling</span>')
    expect(out).toContain('<span class="note-row-excerpt">Beds tomatoes</span>')
    for (const when of ['2d ago', '30m ago', '3h ago', '1d ago']) expect(out).toContain(`<span class="note-row-when">${when}</span>`)
  })

  it('marks the pinned note and each pad as a project’s notes, and names no project on a note', () => {
    const out = html()
    expect(out.match(/📌/g)).toHaveLength(1)
    expect(out.match(/<span class="note-row-tag">Project notes<\/span>/g)).toHaveLength(2)
    // "Paint colours" was saved about Hall; its row does not say so
    expect(out).not.toContain('pchip')
    expect(out).not.toContain('title="Hall"')
  })

  it('marks a pinned pad as a pinned note is marked, and puts it on top', () => {
    const pinned = [{ ...PROJECTS[1], notesPinned: true }, ...PROJECTS.filter(p => p.id !== 'p-garden')]
    const out = renderToStaticMarkup(<NotesView projects={pinned} notes={NOTES} onSaveNote={noop} {...shell} />)
    // pinned ones newest first: the pad was edited on the 11th, the note on the 10th
    expect(rowTitles(out)).toEqual(['Garden', 'Paint colours', 'Gift ideas', '🏡 Hall', UNTITLED])
    expect(out.match(/<span class="note-row-pin" title="Pinned">📌<\/span>/g)).toHaveLength(2)
  })

  it('offers + New note and a search box', () => {
    expect(html()).toContain('<button type="button" class="btn primary">+ New note</button>')
    expect(html()).toContain('aria-label="Search notes"')
  })

  it('filters by title and text', () => {
    const index = (query: string) => renderToStaticMarkup(<NotesIndex notes={NOTES} projects={PROJECTS} query={query} onQuery={noop} onOpenNote={noop} onOpenPad={noop} onNewNote={noop} />)
    expect(rowTitles(index('sage'))).toEqual(['Paint colours', '🏡 Hall'])
    expect(rowTitles(index('GIFT'))).toEqual(['Gift ideas'])
    expect(rowTitles(index('tomatoes'))).toEqual(['Garden'])
    const none = index('zebra')
    expect(none).toContain('No notes match “zebra”.')
    expect(rowTitles(none)).toEqual([])
  })

  it('says so when there is nothing yet, with no search box', () => {
    const empty = renderToStaticMarkup(<NotesView projects={[project('p-garage', { name: 'Garage' })]} notes={[]} onSaveNote={noop} {...shell} />)
    expect(empty).toContain('No notes yet')
    expect(empty).toContain('+ New note')
    expect(empty).not.toContain('Search notes')
  })

  it('has no + New note when nothing can save one', () => {
    expect(renderToStaticMarkup(<NotesView projects={PROJECTS} notes={NOTES} {...shell} />)).not.toContain('New note')
  })

  it('still opens a project pad exactly as before', () => {
    const pad = (extra: object) => renderToStaticMarkup(<NotesView projects={PROJECTS} project={PROJECTS[0]} {...shell} {...extra} />)
    expect(pad({ notes: NOTES, onSaveNote: noop, onDeleteNote: noop })).toBe(pad({}))
  })
})

describe('a note’s screen', () => {
  const pane = (over: Partial<Parameters<typeof NotePane>[0]> = {}) => renderToStaticMarkup(<NotePane note={NOTES[1]} stored={NOTES[1]} onSave={noop} onDelete={noop} onBack={noop} onCreateTask={noop} {...over} />)

  it('opens a new note on an empty title, with nothing to delete and a word on when it saves', () => {
    const fresh = blankNote('fresh', NOW)
    const out = pane({ note: fresh, stored: undefined })
    expect(out).toContain('aria-label="Note title"')
    expect(out).toContain('placeholder="Title"')
    expect(out).toContain('value=""')
    expect(out).not.toContain('>Delete<')
    expect(out).toContain('Saves once it has a title or some text')
    expect(out).toContain('>📌 Pin<')
    expect(out).toContain('>All notes<')
    // the pad's own editor
    expect(out).toContain('class="notes-editable md"')
  })

  it('never asks what a note is about: no About, no project picker', () => {
    for (const out of [pane(), pane({ note: NOTES[0], stored: NOTES[0] })]) {
      expect(out).not.toContain('<select')
      expect(out).not.toContain('About')
      expect(out).not.toContain('No project')
      expect(out).not.toContain('Hall')
    }
  })

  it('shows an untitled note as an empty title with "Untitled note" as its placeholder', () => {
    const out = pane({ note: NOTES[2], stored: NOTES[2] })
    expect(out).toContain('placeholder="Untitled note"')
    expect(out).toContain('value=""')
    expect(out).toContain('Autosaves as you type')
  })

  it('offers Delete on a saved note as a two-step button that says what it does, and none without onDelete', () => {
    expect(pane()).toMatch(/<button type="button" class="btn subtle danger" title="Delete: [^"]*" aria-label="Delete: [^"]*" data-tip="Delete: [^"]*">Delete<\/button>/)
    expect(pane({ onDelete: undefined })).not.toContain('>Delete<')
  })

  it('reaches onDelete only through that button’s confirm, with nothing saved after it', () => {
    const src = readFileSync(new URL('../components/notes/NotePane.tsx', import.meta.url), 'utf8')
    expect(src.match(/saver\.remove\(\)/g)).toHaveLength(1)
    expect(src).toMatch(/<ConfirmButton\b[^>]*onConfirm=\{\(\) => \{\s*saver\.remove\(\)/)
    expect(src.match(/onDelete\?\.\(/g)).toHaveLength(1)
  })

  it('offers Unpin on a pinned note', () => {
    expect(pane({ note: NOTES[0], stored: NOTES[0] })).toContain('>📌 Unpin<')
  })
})
