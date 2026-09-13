import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NotesView } from '../components/NotesView'
import { noteHits } from '../components/Search'
import type { Note } from '../types'

// Cmd/Ctrl+K finds notes as well as tasks, projects, people and places, and
// picking one opens it in Tasks → Notes.

const T0 = '2026-09-12T09:00:00.000Z'
const note = (id: string, title: string, body: string, over: Partial<Note> = {}): Note => ({ kind: 'note', id, title, body, createdAt: T0, updatedAt: T0, ...over })

describe('the palette finds notes', () => {
  const NOTES = [
    note('hall', 'Hall paint', '<p>Sage, two coats</p>'),
    note('garden', 'Garden', '<p>Raised beds by the fence, then paint the shed sage</p>'),
    note('gone', 'Paint samples', '<p>old</p>', { deletedAt: T0 }),
  ]

  it('ranks a title match over one in the text, and says where the text matched', () => {
    const hits = noteHits(NOTES, 'paint')
    expect(hits.map(h => h.note.id)).toEqual(['hall', 'garden'])
    const [title, text] = hits
    expect(title.score).toBeGreaterThan(text.score)
    expect(title.where).toBe('')
    expect(text.where).toContain('paint the shed sage')
  })

  it('leaves out deleted notes and notes that do not match', () => {
    expect(noteHits(NOTES, 'samples')).toEqual([])
    expect(noteHits(NOTES, 'tiles')).toEqual([])
  })
})

describe('Notes opens a note asked for from the palette', () => {
  const noop = () => {}
  const shell = { projects: [], getLatest: () => undefined, onSave: noop, onSelectProject: noop, onBack: noop, onNewProject: noop, onCreateTask: noop, onSaveNote: noop }
  const NOTES = [note('n1', 'Paint colours', '<p>Sage for the hall</p>'), note('n2', 'Garden', '<p>Beds</p>')]

  it('shows that note instead of the list', () => {
    const html = renderToStaticMarkup(<NotesView {...shell} notes={NOTES} openNoteId="n1" />)
    expect(html).toContain('Paint colours')
    expect(html).not.toContain('Garden')
  })

  it('shows the list when the note asked for is not there', () => {
    const html = renderToStaticMarkup(<NotesView {...shell} notes={NOTES} openNoteId="missing" />)
    expect(html).toContain('Garden')
    expect(html).toContain('Paint colours')
  })
})
