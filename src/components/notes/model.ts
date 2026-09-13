import { newerStamp } from '../../itemops'
import { renderMarkdown } from '../../markdown'
import { htmlToText } from '../../richtext'
import { sortNotes } from '../../store'
import { Note, Project } from '../../types'
import { fmtDate } from '../../utils'

// The rules of Tasks → Notes, kept out of the components so node can test
// them: what the list shows and in what order, what a search matches, and when
// a note is saved. A project pad is never rewritten into a note — the list
// shows it beside the notes, and opening it edits the project as it always has.

/** What a note with text but no title is called, in the list and in the store. */
export const UNTITLED = 'Untitled note'

/** A project pad's HTML, converting legacy Markdown notes on the fly. */
export function noteHtml(p: Project): string {
  if (p.notesHtml !== undefined) return p.notesHtml
  return p.notes ? renderMarkdown(p.notes) : ''
}

/** True when a body has something in it: words, a checkbox or a photo. An empty paragraph is not. */
export function hasNoteText(html: string): boolean {
  return htmlToText(html).trim() !== '' || /<img\b[^>]*\bdata-media=/i.test(html)
}

/** One line of plain text: the excerpt under a title, and what a search reads. */
const plain = (html: string) => htmlToText(html).replace(/\s+/g, ' ').trim()

/** One row of the Notes list: a note record, or a project's pad. */
export interface NoteEntry {
  /** `note:<id>` or `pad:<projectId>`, unique across both. */
  key: string
  kind: 'note' | 'pad'
  /** The note's id, or the pad's project id. */
  id: string
  /** A note's title ("Untitled note" when it has none), or the pad's project name. */
  title: string
  text: string
  updatedAt: string
  /** A pinned note, or a pad whose project has notesPinned. */
  pinned: boolean
  /** What a note is about, or the pad's own project. */
  projectId?: string
}

/** Every word of `query` appears in one of `fields`, in any case. An empty query matches everything. */
export function matchesQuery(query: string, ...fields: string[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = fields.join('\n').toLowerCase()
  return words.every(w => hay.includes(w))
}

/**
 * The Notes list: note records and every project pad with something in it
 * (archived projects stay out, as they did on the pad index), narrowed to
 * `query`. Pinned notes and pinned pads come first, then the other notes and
 * pads; within each, the notes (in sortNotes order) and the pads go together,
 * most recently edited first. A pad's edit time is its project's; on a tie a
 * note comes before a pad, and pads go by id.
 */
export function notesIndex(notes: Note[], projects: Project[], query = ''): NoteEntry[] {
  const sorted = sortNotes(notes.filter(n => !n.deletedAt)).map(
    (n): NoteEntry => ({ key: `note:${n.id}`, kind: 'note', id: n.id, title: n.title || UNTITLED, text: plain(n.body), updatedAt: n.updatedAt, pinned: !!n.pinned, projectId: n.projectId }),
  )
  const pads = projects
    .filter(p => p.status !== 'archived' && !p.deletedAt)
    .map(p => ({ p, html: noteHtml(p) }))
    .filter(({ html }) => hasNoteText(html))
    .map(({ p, html }): NoteEntry => ({ key: `pad:${p.id}`, kind: 'pad', id: p.id, title: p.name, text: plain(html), updatedAt: p.updatedAt, pinned: !!p.notesPinned, projectId: p.id }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  const pinned = newestFirst(
    sorted.filter(e => e.pinned),
    pads.filter(e => e.pinned),
  )
  const rest = newestFirst(
    sorted.filter(e => !e.pinned),
    pads.filter(e => !e.pinned),
  )
  return [...pinned, ...rest].filter(e => matchesQuery(query, e.title, e.text))
}

/** Two lists that are each newest first, merged into one; on a tie the note goes first. */
function newestFirst(notes: NoteEntry[], pads: NoteEntry[]): NoteEntry[] {
  const merged: NoteEntry[] = []
  for (let i = 0, j = 0; i < notes.length || j < pads.length; ) {
    if (j >= pads.length || (i < notes.length && notes[i].updatedAt >= pads[j].updatedAt)) merged.push(notes[i++])
    else merged.push(pads[j++])
  }
  return merged
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function editedLabel(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days < 7 ? `${days}d ago` : fmtDate(iso)
}

/** The fields a note's screen edits. */
export interface NoteDraft {
  title: string
  body: string
  projectId?: string
  pinned?: boolean
}

/** A stored note as its screen shows it: "Untitled note" reads as an empty title with that as the placeholder. */
export function draftOf(n: Note): NoteDraft {
  return { title: n.title === UNTITLED ? '' : n.title, body: n.body, projectId: n.projectId, pinned: !!n.pinned }
}

/** A new note. It reaches the store only once it has a title or some text. */
export function blankNote(id: string, now: string): Note {
  return { kind: 'note', id, title: '', body: '', createdAt: now, updatedAt: now }
}

/**
 * The note to save for `draft`, made on `base` (the newest copy known) and
 * stamped newer than it; null while it has neither a title nor any text, since
 * a blank note is never saved. Text with no title is saved as "Untitled note".
 */
export function noteToSave(base: Note, draft: NoteDraft): Note | null {
  const title = draft.title.trim()
  if (!title && !hasNoteText(draft.body)) return null
  return { ...base, title: title || UNTITLED, body: draft.body, projectId: draft.projectId || undefined, pinned: draft.pinned || undefined, updatedAt: newerStamp(base.updatedAt) }
}

const sameNote = (a: Note, b: Note) => a.title === b.title && a.body === b.body && (a.projectId || undefined) === (b.projectId || undefined) && !!a.pinned === !!b.pinned

export interface NoteSaverOptions {
  /** The note as opened: a stored note, or a new one the store has not seen. */
  note: Note
  /** The store's copy right now: undefined before a new note's first save, and once it is deleted. */
  stored(): Note | undefined
  save(n: Note): void
  /** Tombstone it (the shell's store.remove). */
  remove(id: string): void
  /** After each save attempt: the note written, or null when there was nothing to write. */
  onFlushed?(saved: Note | null): void
  /** Quiet time before an edit is saved, as on a project pad. */
  delay?: number
}

export interface NoteSaver {
  /** Take the latest draft; it is saved once `delay` ms pass without another. */
  change(draft: NoteDraft): void
  /** Save the waiting draft now (a pin, leaving, the app going to the background). */
  flush(): Note | null
  /** The two-step Delete, confirmed: save what was typed (so Trash holds it), then tombstone. Nothing saves after it. */
  remove(): void
  /** Deleted somewhere else: drop the waiting draft and never save again, since a save would bring it back. */
  abandon(): void
  pending(): boolean
  /** True once the store has the note, from this screen or before it opened. */
  saved(): boolean
}

/** The autosave behind a note's screen, as a plain object so it can be tested without a DOM. */
export function createNoteSaver(o: NoteSaverOptions): NoteSaver {
  const delay = o.delay ?? 800
  let draft: NoteDraft | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let last: Note | null = null
  let over = false

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  /** The store's copy, or the one written here if the store has not caught up with it yet. */
  const newest = (): Note | undefined => {
    const s = o.stored()
    if (!last) return s
    return s && s.updatedAt >= last.updatedAt ? s : last
  }

  function flush(): Note | null {
    stop()
    if (over || !draft) return null
    const d = draft
    draft = null
    const base = newest()
    const next = noteToSave(base ?? o.note, d)
    if (!next || (base && sameNote(base, next))) {
      o.onFlushed?.(null)
      return null
    }
    last = next
    o.save(next)
    o.onFlushed?.(next)
    return next
  }

  return {
    change(d) {
      if (over) return
      draft = d
      stop()
      timer = setTimeout(flush, delay)
    },
    flush,
    remove() {
      if (over) return
      flush()
      over = true
      if (newest()) o.remove(o.note.id)
    },
    abandon() {
      over = true
      draft = null
      stop()
    },
    pending: () => draft !== null,
    saved: () => !!newest(),
  }
}
