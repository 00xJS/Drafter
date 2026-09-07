import { useEffect, useRef, useState } from 'react'
import { Project } from '../types'
import { newerStamp } from '../itemops'
import { renderMarkdown, wordCount } from '../markdown'
import { excerpt, timeAgo } from '../utils'
import { NotesEditor } from './NotesEditor'

interface PaneProps {
  project: Project
  getLatest(id: string): Project | undefined
  onSave(p: Project): void
}

/** One project's notes pad, autosaving as you type (debounced). */
function NotesPane({ project, getLatest, onSave }: PaneProps) {
  const [text, setText] = useState(project.notes ?? '')
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
    if ((current.notes ?? '') === textRef.current) return
    onSave({ ...current, notes: textRef.current || undefined, updatedAt: newerStamp(current.updatedAt) })
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
    if (!dirtyRef.current && (project.notes ?? '') !== textRef.current) setText(project.notes ?? '')
  }, [project.notes])

  return (
    <div className="notes-page">
      <header className="notes-page-head">
        <h2 className="view-title">
          <span className="pdot" style={{ background: project.color }} /> {project.emoji ? `${project.emoji} ` : ''}
          {project.name} · Notes
        </h2>
      </header>
      <NotesEditor value={text} onChange={change} status={dirty ? 'Saving…' : savedAt ? `Saved ${timeAgo(savedAt)}` : 'Autosaves as you type'} />
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
}

export function NotesView({ projects, project, getLatest, onSave, onSelectProject, onNewProject }: Props) {
  if (project) return <NotesPane key={project.id} project={project} getLatest={getLatest} onSave={onSave} />

  const visible = projects.filter(p => p.status !== 'archived')
  if (visible.length === 0) {
    return (
      <div className="empty-hero">
        <h2>Notes live inside projects</h2>
        <p>Create a project and its notes pad appears here: a place to brainstorm with headings, lists, links, code and emoji.</p>
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
          const words = p.notes ? wordCount(p.notes) : 0
          return (
            <button key={p.id} className="project-card notes-card" onClick={() => onSelectProject(p.id)}>
              <span className="project-card-head">
                <span className="pdot" style={{ background: p.color }} />
                <span className="project-card-name">
                  {p.emoji && <span>{p.emoji} </span>}
                  {p.name}
                </span>
                <span className="project-card-pct">{words ? `${words} words` : 'empty'}</span>
              </span>
              {p.notes ? (
                <span className="notes-card-preview md" dangerouslySetInnerHTML={{ __html: renderMarkdown(excerpt(p.notes, 400)) }} />
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
