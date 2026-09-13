import { useEffect, useRef, useState } from 'react'
import { Note, Project } from '../types'
import { newerStamp } from '../itemops'
import { htmlToText, wordCountHtml } from '../richtext'
import { excerpt, timeAgo, uid } from '../utils'
import { RichNotes } from './RichNotes'
import { NotePane } from './notes/NotePane'
import { NotesIndex } from './notes/NotesIndex'
import { blankNote, noteHtml } from './notes/model'

/** The note's HTML, converting legacy Markdown notes on the fly. */
export { noteHtml }

interface PaneProps {
  project: Project
  getLatest(id: string): Project | undefined
  onSave(p: Project): void
  onCreateTask(title: string, projectId: string): void
  /** Back to the index of every project's notes — the pad's only way out now that no bar selects projects. */
  onBack(): void
}

/** One project's notes pad, autosaving as you type (debounced). */
function NotesPane({ project, getLatest, onSave, onCreateTask, onBack }: PaneProps) {
  const [text, setText] = useState(() => noteHtml(project))
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const textRef = useRef(text)
  textRef.current = text

  const persist = () => {
    if (!dirtyRef.current) return
    const current = getLatest(project.id) ?? project
    dirtyRef.current = false
    setDirty(false)
    if (noteHtml(current) === textRef.current) return
    // the markdown field is retired once rich notes exist; keep a plain-text copy for agents/search
    onSave({ ...current, notesHtml: textRef.current, notes: htmlToText(textRef.current) || undefined, updatedAt: newerStamp(current.updatedAt) })
    setSavedAt(new Date().toISOString())
  }

  const change = (next: string) => {
    setText(next)
    dirtyRef.current = true
    setDirty(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(persist, 800)
  }

  // save when the tab goes to the background and when this pane unmounts
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.clearTimeout(timer.current)
      persist()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // another device edited the notes while this pane was idle: take theirs
  useEffect(() => {
    const incoming = noteHtml(project)
    if (!dirtyRef.current && incoming !== textRef.current) setText(incoming)
  }, [project.notesHtml, project.notes]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="notes-page">
      <header className="notes-page-head">
        <button type="button" className="btn subtle notes-back" onClick={onBack}>
          All notes
        </button>
        <h2 className="view-title">
          <span className="pdot" style={{ background: project.color }} /> {project.emoji ? `${project.emoji} ` : ''}
          {project.name} · Notes
        </h2>
      </header>
      <RichNotes value={text} onChange={change} autoFocus status={dirty ? 'Saving…' : savedAt ? `Saved ${timeAgo(savedAt)}` : 'Autosaves as you type'} onCreateTask={title => onCreateTask(title, project.id)} />
    </div>
  )
}

interface Props {
  projects: Project[]
  /** The project whose pad is open; undefined shows the index of every project's notes. */
  project?: Project
  getLatest(id: string): Project | undefined
  onSave(p: Project): void
  /** Open one project's pad. A selection local to the Notes segment — it must never filter the other views. */
  onSelectProject(id: string): void
  /** Close the pad and show the index again. */
  onBack(): void
  onNewProject(): void
  onCreateTask(title: string, projectId: string): void
  /**
   * Note records, pinned first then most recently edited (store.notes). Passing
   * it turns the index into one list of these notes and every non-empty project
   * pad, with a search and "+ New note"; without it the index is the grid of
   * project pads it has always been. An open pad (`project`) wins either way.
   */
  notes?: Note[]
  /** Save a note (store.upsert). A new note is first saved once it has a title or some text. */
  onSaveNote?(n: Note): void
  /** Delete a note (store.remove: a tombstone Trash can restore), after the two-step confirm. */
  onDeleteNote?(id: string): void
  /** A note to open, asked for from elsewhere (the palette's search). It opens once; then onOpenNoteDone lets the shell forget it. */
  openNoteId?: string
  onOpenNoteDone?(): void
}

export function NotesView({ projects, project, getLatest, onSave, onSelectProject, onBack, onNewProject, onCreateTask, notes, onSaveNote, onDeleteNote, openNoteId, onOpenNoteDone }: Props) {
  /** The note on screen: a stored one, or a new one not saved yet. Local to Notes, like the pad the shell holds. */
  const [open, setOpen] = useState<Note | null>(null)
  /** The list's search, kept while a note is open so All notes comes back to the same list. */
  const [query, setQuery] = useState('')
  // a pad opened from elsewhere (the project editor's Notes button) replaces the
  // note on screen, so the pad's All notes lands on the list rather than on it
  const [padId, setPadId] = useState(project?.id)
  if (padId !== project?.id) {
    setPadId(project?.id)
    if (project) setOpen(null)
  }
  // a note asked for from elsewhere opens once, and the shell then forgets it,
  // so asking for the same note again opens it again
  const [askedId, setAskedId] = useState<string | undefined>(undefined)
  if (openNoteId !== askedId) {
    setAskedId(openNoteId)
    const asked = openNoteId ? notes?.find(n => n.id === openNoteId) : undefined
    if (asked) setOpen(asked)
  }
  useEffect(() => {
    if (openNoteId) onOpenNoteDone?.()
  }, [openNoteId, onOpenNoteDone])

  if (project) return <NotesPane key={project.id} project={project} getLatest={getLatest} onSave={onSave} onCreateTask={onCreateTask} onBack={onBack} />

  if (notes) {
    if (open) {
      return (
        <NotePane
          key={open.id}
          note={open}
          stored={notes.find(n => n.id === open.id)}
          projects={projects}
          onSave={n => onSaveNote?.(n)}
          onDelete={onDeleteNote}
          onBack={() => setOpen(null)}
          onCreateTask={onCreateTask}
        />
      )
    }
    return (
      <NotesIndex
        notes={notes}
        projects={projects}
        query={query}
        onQuery={setQuery}
        onOpenNote={id => setOpen(notes.find(n => n.id === id) ?? null)}
        onOpenPad={onSelectProject}
        onNewNote={
          onSaveNote
            ? () => {
                // a new note must be in the list it returns to
                setQuery('')
                setOpen(blankNote(uid(), new Date().toISOString()))
              }
            : undefined
        }
      />
    )
  }

  const visible = projects.filter(p => p.status !== 'archived')
  if (visible.length === 0) {
    return (
      <div className="empty-hero">
        <h2>Notes live inside projects</h2>
        <p>Create a project and its notepad appears here: brainstorm with headings, lists, checklists, links, code, emoji and photos dropped straight in.</p>
        <p>
          <button className="btn primary" onClick={onNewProject}>
            + New project
          </button>
        </p>
      </div>
    )
  }

  return (
    <div className="notes-index">
      <div className="toolbar">
        <h2 className="view-title">Notes</h2>
        <span className="cal-hint">Pick a project to open its pad</span>
      </div>
      <div className="project-cards notes-cards">
        {visible.map(p => {
          const html = noteHtml(p)
          const words = html ? wordCountHtml(html) : 0
          const photos = (html.match(/data-media=/g) ?? []).length
          return (
            <button key={p.id} className="project-card notes-card" onClick={() => onSelectProject(p.id)}>
              <span className="project-card-head">
                <span className="pdot" style={{ background: p.color }} />
                <span className="project-card-name">
                  {p.emoji && <span>{p.emoji} </span>}
                  {p.name}
                </span>
                <span className="project-card-pct">
                  {words ? `${words} words` : 'empty'}
                  {photos ? ` · ${photos} photo${photos === 1 ? '' : 's'}` : ''}
                </span>
              </span>
              {html ? (
                <span className="notes-card-preview">{excerpt(htmlToText(html), 260)}</span>
              ) : (
                <span className="project-card-sub">No notes yet — click to start.</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
