import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NotePane } from '../components/notes/NotePane'
import { NotesView } from '../components/NotesView'
import { RichNotes } from '../components/RichNotes'
import { migrateStored, sanitizeItem, sanitizeProject } from '../schema'
import { Note, Project } from '../types'
import { sheetSource } from './source'

// The Notes pages' buttons say what they do: each carries a tooltip shown at
// once on hover or keyboard focus (data-tip, drawn by NoteTips), in the same
// words as its aria-label and title. None is drawn with U+2610 (☐), which
// showed as an empty box. A project's notepad has a Pin as a note does, kept on
// the project as notesPinned.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const T0 = '2026-09-01T09:00:00.000Z'
const noop = () => {}
const LIFE: Project = { kind: 'project', id: 'p-life', name: 'LIFE', color: '#f97316', status: 'active', notesHtml: '<p>Groceries on Sunday</p>', createdAt: T0, updatedAt: T0 }
const NOTE: Note = { kind: 'note', id: 'n1', title: 'Garden', body: '<p>Beds</p>', createdAt: T0, updatedAt: T0 }

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
/** The opening tag of every button in `html`. */
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>/g)].map(m => m[0])
/** The buttons inside the page's header. */
const headButtons = (html: string) => buttons(html.slice(html.indexOf('<header'), html.indexOf('</header>')))

/** The words a button says, once its tooltip, aria-label and title are shown to agree. */
function words(tag: string): string {
  const tip = attr(tag, 'data-tip')
  expect(tip, tag).toBeTruthy()
  expect(attr(tag, 'aria-label'), tag).toBe(tip)
  expect(attr(tag, 'title'), tag).toBe(tip)
  return tip!
}

describe('every tool on the notes bar says what it does', () => {
  const bar = renderToStaticMarkup(<RichNotes value="<p>x</p>" onChange={noop} onCreateTask={noop} />)
  const tools = [...bar.matchAll(/<(button|label)\b[^>]*>/g)].map(m => m[0]).filter(t => /class="[^"]*\bnotes-tool\b/.test(t))

  it('gives each a tooltip, with the same words as its aria-label and title', () => {
    // B I U S H ¶ • 1. checklist, quote, code, code block, link, divider, emoji, Task, photos
    expect(tools).toHaveLength(17)
    const all = tools.map(words)
    expect(new Set(all).size).toBe(all.length)
    for (const w of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'Heading', 'Normal text', 'Bulleted list', 'Numbered list', 'Checklist', 'Quote', 'Code:', 'Code block', 'Link', 'Divider', 'Emoji', 'task', 'photos']) expect(all.some(t => t.includes(w)), w).toBe(true)
  })

  it('makes the photo picker a button, so the keyboard reaches it too', () => {
    expect(tools.every(t => t.startsWith('<button'))).toBe(true)
    expect(bar).toContain('<input type="file" accept="image/*" multiple="" hidden=""/>')
  })

  it('draws no tool with U+2610, which showed as an empty box', () => {
    expect(bar).not.toContain('☐')
    expect(read('../components/RichNotes.tsx')).not.toContain('☐')
    // the checklist, Task's + and the photo picker are icons in the text's colour
    expect(bar.match(/<svg/g)).toHaveLength(3)
  })
})

describe('the page header’s buttons say what they do', () => {
  it('on a note: All notes, Pin and Delete', () => {
    const html = renderToStaticMarkup(<NotePane note={NOTE} stored={NOTE} onSave={noop} onDelete={noop} onBack={noop} onCreateTask={noop} />)
    expect(headButtons(html).map(words).map(w => w.split(':')[0])).toEqual(['Back to all notes', 'Pin', 'Delete'])
  })

  it('on a notepad: All notes and a Pin of its own', () => {
    const pad = (p: Project) => renderToStaticMarkup(<NotesView projects={[p]} project={p} getLatest={() => p} onSave={noop} onSelectProject={noop} onBack={noop} onCreateTask={noop} />)
    expect(headButtons(pad(LIFE)).map(words).map(w => w.split(':')[0])).toEqual(['Back to all notes', 'Pin'])
    expect(pad(LIFE)).toContain('>📌 Pin<')
    expect(pad({ ...LIFE, notesPinned: true })).toContain('>📌 Unpin<')
  })

  it('has no About picker on a note’s page, even for a note saved with a project', () => {
    const about = { ...NOTE, projectId: LIFE.id }
    expect(renderToStaticMarkup(<NotePane note={about} stored={about} onSave={noop} onDelete={noop} onBack={noop} onCreateTask={noop} />)).not.toMatch(/<select|About|note-about/)
  })
})

describe('a notepad’s pin', () => {
  it('survives the schema, on load and through a sync’s JSON', () => {
    expect(sanitizeProject({ ...LIFE, notesPinned: true })?.notesPinned).toBe(true)
    expect(sanitizeItem(JSON.parse(JSON.stringify({ ...LIFE, notesPinned: true })))).toMatchObject({ kind: 'project', notesPinned: true })
    expect(migrateStored({ version: 3, items: [{ ...LIFE, notesPinned: true }] })?.[0]).toMatchObject({ notesPinned: true })
  })

  it('keeps only a real true', () => {
    for (const v of [false, 'yes', 1, null, undefined]) expect(sanitizeProject({ ...LIFE, notesPinned: v })?.notesPinned).toBeUndefined()
  })

  it('saves with any words waiting to save, under one newer stamp', () => {
    const src = read('../components/NotesView.tsx')
    expect(src).toContain('persist(current => ({ notesPinned: current.notesPinned ? undefined : true }))')
    expect(src).toContain('onSave({ ...current, ...words, ...also?.(current), updatedAt: newerStamp(current.updatedAt) })')
  })
})

describe('the tooltip’s look', () => {
  it('lives in the notes partial: fixed, never taking the pointer, in the theme’s tokens', () => {
    const notes = read('../styles/10-editor-notes.css')
    const at = notes.indexOf('.notes-tip {')
    const rule = notes.slice(at, notes.indexOf('}', at))
    for (const line of ['position: fixed', 'pointer-events: none', 'background: var(--inverse-bg)', 'color: var(--inverse-text)']) expect(rule, line).toContain(line)
    expect(sheetSource().split('.notes-tip {')).toHaveLength(2)
  })
})
