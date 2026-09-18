import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotePane } from '../components/notes/NotePane'
import { NotesIndex } from '../components/notes/NotesIndex'
import { Note } from '../types'
import { button, elements, press, settled, textOf } from './rendered'

// The Share toggle, driven rather than grepped: pressing it has to reach
// onSave, and the note that lands there has to carry the flag the database
// reads. A test that only looked for the word "Shared" in the source would
// pass with the handler wired to nothing.

const T0 = '2026-09-01T09:00:00.000Z'
const ME = 'user-me'
const PEER = 'user-peer'

const note = (id: string, over: Partial<Note> = {}): Note => ({
  kind: 'note',
  id,
  title: 'Paint colours',
  body: '<p>Sage for the hall</p>',
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

const noop = () => {}
const base = { onDelete: noop, onBack: noop, onCreateTask: noop, myId: ME, inHousehold: true }

/** Every button's words, as a reader would hear them. */
const buttons = (tree: ReturnType<typeof settled>) =>
  elements(tree)
    .filter(e => e.type === 'button')
    .map(e => textOf(e.props.children).replace(/\s+/g, ' ').trim())

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-12T12:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a note says whose it is, on the note', () => {
  it('reads Private until it is shared, which is what a note is', () => {
    const stored = note('n1', { ownerId: ME })
    const tree = settled(NotePane, { ...base, note: stored, stored, onSave: noop })
    expect(buttons(tree)).toContain('🔒 Private')
    expect(button(tree, '🔒 Private').props['aria-pressed']).toBe(false)
  })

  it('reads Shared once it is, so the answer is on the screen and not in Settings', () => {
    const stored = note('n1', { ownerId: ME, shared: true })
    const tree = settled(NotePane, { ...base, note: stored, stored, onSave: noop })
    expect(buttons(tree)).toContain('👥 Shared')
    expect(button(tree, '👥 Shared').props['aria-pressed']).toBe(true)
  })

  it('presses like the pin: one press shares it, and the saved note carries the flag', () => {
    const saved: Note[] = []
    const stored = note('n1', { ownerId: ME })
    settled(NotePane, { ...base, note: stored, stored, onSave: (n: Note) => saved.push(n) }, tree => press(tree, '🔒 Private'))
    expect(saved).toHaveLength(1)
    expect(saved[0].shared).toBe(true)
    // and nothing else about the note moved
    expect(saved[0]).toMatchObject({ id: 'n1', title: 'Paint colours', body: '<p>Sage for the hall</p>' })
  })

  it('and one press takes it back: absent, not false, which is what the policy reads', () => {
    const saved: Note[] = []
    const stored = note('n1', { ownerId: ME, shared: true })
    settled(NotePane, { ...base, note: stored, stored, onSave: (n: Note) => saved.push(n) }, tree => press(tree, '👥 Shared'))
    expect(saved).toHaveLength(1)
    expect(saved[0].shared).toBeUndefined()
  })

  it('offers no toggle on somebody else’s note — only its owner can stop sharing it', () => {
    const stored = note('n2', { ownerId: PEER, shared: true })
    const tree = settled(NotePane, { ...base, note: stored, stored, ownerName: 'Maria', onSave: noop })
    expect(buttons(tree)).not.toContain('👥 Shared')
    expect(buttons(tree)).not.toContain('🔒 Private')
    expect(textOf(tree)).toContain('Maria’s note')
  })

  it('says so plainly when the household has no name for them', () => {
    const stored = note('n2', { ownerId: PEER, shared: true })
    expect(textOf(settled(NotePane, { ...base, note: stored, stored, ownerName: null, onSave: noop }))).toContain('Shared with you')
  })

  it('stays away entirely outside a household: there is nobody to share with', () => {
    const stored = note('n1', { ownerId: ME })
    const tree = settled(NotePane, { ...base, inHousehold: false, note: stored, stored, onSave: noop })
    expect(buttons(tree)).not.toContain('🔒 Private')
    expect(textOf(tree)).not.toContain('Shared with you')
    // the pin is still there, so this is the share control and not the header
    expect(buttons(tree)).toContain('📌 Pin')
  })

  it('a new note starts private, with the toggle already there to change that', () => {
    const fresh = note('n-new', { title: '', body: '' })
    const tree = settled(NotePane, { ...base, note: fresh, stored: undefined, onSave: noop })
    expect(buttons(tree)).toContain('🔒 Private')
  })
})

describe('the list marks the shared ones', () => {
  const list = (notes: Note[], nameOf?: (id: string | undefined) => string | null) =>
    settled(NotesIndex, { notes, projects: [], myId: ME, nameOf, query: '', onQuery: noop, onOpenNote: noop, onOpenPad: noop })

  const badges = (tree: ReturnType<typeof settled>) =>
    elements(tree)
      .filter(e => e.type === 'span' && e.props.className === 'note-row-share')
      .map(e => textOf(e.props.children).replace(/\s+/g, ' ').trim())

  it('marks a shared note and leaves a private one unmarked — private is the default, so a badge on every row says nothing', () => {
    expect(badges(list([note('a', { ownerId: ME, shared: true }), note('b', { ownerId: ME })]))).toEqual(['👥 Shared'])
  })

  it('names whoever shared a note with you', () => {
    const tree = list([note('c', { ownerId: PEER, shared: true })], id => (id === PEER ? 'Maria' : null))
    expect(badges(tree)).toEqual(['👥 Maria'])
  })

  it('marks a peer’s note however the flag reads: it could not be in this list otherwise', () => {
    // the database would not have returned it, so what arrived is shared
    expect(badges(list([note('d', { ownerId: PEER })], () => 'Maria'))).toEqual(['👥 Maria'])
  })
})
