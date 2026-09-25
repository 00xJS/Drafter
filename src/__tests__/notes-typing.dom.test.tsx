// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMIT_AFTER_MS, RichNotes } from '../components/RichNotes'
import { NotesView } from '../components/NotesView'
import { NotePane } from '../components/notes/NotePane'
import { wordCountHtml } from '../richtext'
import type { Note, Project } from '../types'

// Every key in the notes pad copied the whole note, sanitized it (a
// DOMParser) and handed it up, and the re-render parsed it again to count its
// words. A burst of typing is written out and counted once now, a beat after
// the last key — and at once on a blur, the page hiding, the pad closing and
// an edit arriving from elsewhere, so no key is ever lost to the wait.

const T0 = '2026-09-12T09:00:00.000Z'
const pad = () => document.querySelector('.notes-editable') as HTMLElement
/** A key typed into the pad: the page changes, and the pad hears it. */
const type = (html: string) => {
  pad().innerHTML = html
  fireEvent.input(pad())
}
const footer = () => document.querySelector('.notes-foot small')?.textContent

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the notes pad writes a burst of typing out once', () => {
  it('a beat after the last key: one copy up, one parse, one count', () => {
    const onChange = vi.fn()
    render(<RichNotes value="<p>Hi</p>" onChange={onChange} />)
    expect(footer()).toMatch(/^1 words/)
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    for (const text of ['Hi t', 'Hi th', 'Hi the', 'Hi ther', 'Hi there']) type(`<p>${text}</p>`)
    expect(onChange).not.toHaveBeenCalled()
    expect(parse).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(EMIT_AFTER_MS - 1))
    expect(onChange).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(onChange.mock.calls).toEqual([['<p>Hi there</p>']])
    // the sanitizer's one parse; the count is read off the pad itself
    expect(parse).toHaveBeenCalledTimes(1)
    expect(footer()).toMatch(/^2 words/)
  })

  it('counts as the saved note is counted, a photo and a tick box among its words', () => {
    const onChange = vi.fn()
    render(<RichNotes value="<p>Hi</p>" onChange={onChange} />)
    type('<ul class="checklist"><li><input type="checkbox"> Milk</li><li><input type="checkbox" checked> Eggs</li></ul><p><img data-media="m1"> Sage paint</p>')
    // a box ticked by a tap: the page says so in the box, not in its markup
    ;(pad().querySelector('input') as HTMLInputElement).checked = true
    act(() => void vi.advanceTimersByTime(EMIT_AFTER_MS))
    const saved = onChange.mock.lastCall![0] as string
    expect(footer()).toBe(`${wordCountHtml(saved)} words · Tap a link to open it`)
    expect(wordCountHtml(saved)).toBeGreaterThanOrEqual(7)
  })

  it('a toolbar action writes out at once', () => {
    const onChange = vi.fn()
    render(<RichNotes value="<p>Hi</p>" onChange={onChange} />)
    document.execCommand = vi.fn(() => true)
    type('<p>Hi there</p>')
    fireEvent.click(screen.getByRole('button', { name: /^Bold/ }))
    expect(onChange).toHaveBeenLastCalledWith('<p>Hi there</p>')
  })
})

describe('no key is lost to the wait', () => {
  it('a blur writes out what was typed', () => {
    const onChange = vi.fn()
    render(<RichNotes value="<p>Hi</p>" onChange={onChange} />)
    type('<p>Hi there</p>')
    fireEvent.blur(pad())
    expect(onChange).toHaveBeenLastCalledWith('<p>Hi there</p>')
    act(() => void vi.advanceTimersByTime(EMIT_AFTER_MS))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('closing the pad writes out what was typed', () => {
    const onChange = vi.fn()
    const { unmount } = render(<RichNotes value="<p>Hi</p>" onChange={onChange} />)
    type('<p>Hi there</p>')
    unmount()
    expect(onChange).toHaveBeenLastCalledWith('<p>Hi there</p>')
  })

  it('the page hiding writes out what was typed', () => {
    const onChange = vi.fn()
    render(<RichNotes value="<p>Hi</p>" onChange={onChange} />)
    type('<p>Hi there</p>')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    expect(onChange).toHaveBeenLastCalledWith('<p>Hi there</p>')
  })

  it('an edit arriving from elsewhere does not overwrite typing not yet written out', () => {
    const onChange = vi.fn()
    const { rerender } = render(<RichNotes value="<p>Hi</p>" onChange={onChange} />)
    type('<p>Hi there</p>')
    rerender(<RichNotes value="<p>From the phone</p>" onChange={onChange} />)
    expect(pad().innerHTML).toBe('<p>Hi there</p>')
    expect(onChange).toHaveBeenLastCalledWith('<p>Hi there</p>')
    // once it is written out, a later edit from elsewhere is taken as before
    rerender(<RichNotes value="<p>From the laptop</p>" onChange={onChange} />)
    expect(pad().innerHTML).toBe('<p>From the laptop</p>')
  })
})

describe('the screens save the last words typed', () => {
  const project = { kind: 'project', id: 'home', name: 'Home', color: '#f97316', status: 'active', notesHtml: '<p>Hi</p>', createdAt: T0, updatedAt: T0 } as Project

  function pane(onSave = vi.fn()) {
    const utils = render(<NotesView projects={[project]} project={project} getLatest={() => project} onSave={onSave} onSelectProject={() => {}} onBack={() => {}} onCreateTask={() => {}} />)
    return { onSave, ...utils }
  }

  it('a project’s pad, closed a moment after the last key', () => {
    const { onSave, unmount } = pane()
    type('<p>Hi there</p>')
    unmount()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ notesHtml: '<p>Hi there</p>', notes: 'Hi there' })
  })

  it('a project’s pad, when the app goes to the background a moment after the last key', () => {
    const { onSave } = pane()
    type('<p>Hi there</p>')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ notesHtml: '<p>Hi there</p>' })
  })

  it('a note, closed a moment after the last key', () => {
    const note: Note = { kind: 'note', id: 'n1', title: 'Paint', body: '<p>Sage</p>', createdAt: T0, updatedAt: T0 }
    const onSave = vi.fn()
    const { unmount } = render(<NotePane note={note} stored={note} onSave={onSave} onBack={() => {}} onCreateTask={() => {}} />)
    type('<p>Sage, two coats</p>')
    unmount()
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'n1', body: '<p>Sage, two coats</p>' }))
  })
})
