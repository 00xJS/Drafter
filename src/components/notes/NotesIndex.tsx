import { useMemo } from 'react'
import { Note, Project } from '../../types'
import { excerpt } from '../../utils'
import { editedLabel, matchesQuery, notesIndex } from './model'

interface Props {
  notes: Note[]
  projects: Project[]
  /** The search, held by the view so All notes comes back to the same list. */
  query: string
  onQuery(q: string): void
  onOpenNote(id: string): void
  /** Open a project's pad, exactly as the pad index did. */
  onOpenPad(projectId: string): void
  /** Absent when nothing can save a note, so there is no button that would lose what is typed. */
  onNewNote?(): void
}

/**
 * Tasks → Notes: every note and every project pad with something in it, pinned
 * ones on top (a pad has a Pin of its own), then newest first. A note's row
 * names no project: there is one ongoing project.
 */
export function NotesIndex({ notes, projects, query, onQuery, onOpenNote, onOpenPad, onNewNote }: Props) {
  const all = useMemo(() => notesIndex(notes, projects), [notes, projects])
  const shown = query.trim() ? all.filter(e => matchesQuery(query, e.title, e.text)) : all
  const byId = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects])
  const now = Date.now()

  return (
    <div className="notes-index notes-records">
      <div className="toolbar">
        <h2 className="view-title">Notes</h2>
        <span className="spacer" />
        {onNewNote && (
          <button type="button" className="btn primary" onClick={onNewNote}>
            + New note
          </button>
        )}
      </div>
      {all.length === 0 ? (
        <div className="empty-hero">
          <h2>No notes yet</h2>
          <p>Give each thing you are thinking about a note of its own: a title, then headings, lists, checklists, links, emoji and photos. A project's notes show up here too once they have something in them.</p>
        </div>
      ) : (
        <>
          <input type="search" className="notes-search" aria-label="Search notes" placeholder="Search notes" value={query} onChange={e => onQuery(e.target.value)} />
          {shown.length === 0 ? (
            <p className="notes-no-match">No notes match “{query.trim()}”.</p>
          ) : (
            <ul className="note-list">
              {shown.map(e => {
                const pad = e.kind === 'pad'
                const project = pad ? byId.get(e.id) : undefined
                return (
                  <li key={e.key}>
                    {/* the {' '} between the parts are for a screen reader, which reads the
                        whole row as one label; flex layout draws none of them */}
                    <button type="button" className={pad ? 'note-row note-row-pad' : 'note-row'} onClick={() => (pad ? onOpenPad(e.id) : onOpenNote(e.id))}>
                      <span className="note-row-head">
                        {e.pinned && (
                          <span className="note-row-pin" title="Pinned">
                            📌
                          </span>
                        )}
                        {project && <span className="pdot" style={{ background: project.color }} />}
                        <span className="note-row-title">{`${project?.emoji ? `${project.emoji} ` : ''}${e.title}`}</span>{' '}
                        <span className="note-row-when">{editedLabel(e.updatedAt, now)}</span>
                      </span>{' '}
                      <span className="note-row-excerpt">{excerpt(e.text, 160) || 'No text yet'}</span>
                      {pad && (
                        <>
                          {' '}
                          <span className="note-row-meta">
                            <span className="note-row-tag">Project notes</span>
                          </span>
                        </>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
