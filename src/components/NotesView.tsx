import { useEffect, useRef, useState } from 'react'
import { Project } from '../types'
import { newerStamp } from '../itemops'
import { renderMarkdown } from '../markdown'
import { htmlToText, wordCountHtml } from '../richtext'
import { excerpt, timeAgo } from '../utils'
import { RichNotes } from './RichNotes'

/** The note's HTML, converting legacy Markdown notes on the fly. */
export function noteHtml(p: Project): string {
  if (p.notesHtml !== undefined) return p.notesHtml
  return p.notes ? renderMarkdown(p.notes) : ''
}

interface PaneProps {
  project: Project
  getLatest(id: string): Project | undefined
  onSave(p: Project): void
  onCreateTask(title: string, projectId: string): void
}

/** One project's notes pad, autosaving as you type (debounced). */
function NotesPane({ project, getLatest, onSave, onCreateTask }: PaneProps) {
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
  /** The project selected in the project bar, if any. */
  project?: Project
  getLatest(id: string): Project | undefined
  onSave(p: Project): void
  onSelectProject(id: string): void
  onNewProject(): void
  onCreateTask(title: string, projectId: string): void
}

export function NotesView({ projects, project, getLatest, onSave, onSelectProject, onNewProject, onCreateTask }: Props) {
  if (project) return <NotesPane key={project.id} project={project} getLatest={getLatest} onSave={onSave} onCreateTask={onCreateTask} />

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
        <span className="cal-hint">Pick a project to open its pad, or select one in the bar above</span>
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
