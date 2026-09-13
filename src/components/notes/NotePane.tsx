import { useEffect, useRef, useState } from 'react'
import { Note, Project } from '../../types'
import { timeAgo } from '../../utils'
import { ConfirmButton } from '../ConfirmButton'
import { RichNotes } from '../RichNotes'
import { createNoteSaver, draftOf, hasNoteText, NoteDraft, UNTITLED } from './model'

interface Props {
  /** The note as opened: a stored note, or a new one the store has not seen yet. */
  note: Note
  /** The store's copy now: undefined until a new note's first save, and again once it is deleted. */
  stored?: Note
  projects: Project[]
  onSave(n: Note): void
  /** Tombstone it; Trash can restore it. Without it there is no Delete. */
  onDelete?(id: string): void
  /** Back to the list. */
  onBack(): void
  /** ☐ Task: the selected line becomes a task, in the note's project when it has one. */
  onCreateTask(title: string, projectId: string): void
}

/**
 * One note: a title, what it is about, and the project pad's own editor. It
 * autosaves as you type, as a pad does, but a new note is not saved until it
 * has a title or some text, and one with text and no title is an "Untitled note".
 */
export function NotePane({ note, stored, projects, onSave, onDelete, onBack, onCreateTask }: Props) {
  const [draft, setDraft] = useState<NoteDraft>(() => draftOf(stored ?? note))
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined)
  const [inStore, setInStore] = useState(!!stored)
  const [isNew] = useState(!stored)
  const draftRef = useRef(draft)
  const storedRef = useRef(stored)
  storedRef.current = stored
  const handlers = useRef({ onSave, onDelete, onBack })
  handlers.current = { onSave, onDelete, onBack }
  /** The version on screen: as opened, as last saved here, or as last taken from another device. */
  const known = useRef((stored ?? note).updatedAt)
  /** Set once the store has held this note, so its disappearing afterwards reads as a delete. */
  const seen = useRef(!!stored)
  const page = useRef<HTMLDivElement>(null)
  const [saver] = useState(() =>
    createNoteSaver({
      note,
      stored: () => storedRef.current,
      save: n => {
        known.current = n.updatedAt
        handlers.current.onSave(n)
      },
      remove: id => handlers.current.onDelete?.(id),
      onFlushed: n => {
        setDirty(false)
        if (n) {
          setSavedAt(new Date().toISOString())
          setInStore(true)
        }
      },
    }),
  )

  const edit = (patch: Partial<NoteDraft>, saveNow = false) => {
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
    setDirty(true)
    saver.change(next)
    if (saveNow) saver.flush()
  }

  // save when the app goes to the background, and when this screen closes
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') saver.flush()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      saver.flush()
    }
  }, [saver])

  useEffect(() => {
    if (stored) {
      seen.current = true
      // another device changed it while nothing here was waiting to save: take theirs
      if (stored.updatedAt !== known.current && !saver.pending()) {
        known.current = stored.updatedAt
        draftRef.current = draftOf(stored)
        setDraft(draftRef.current)
      }
    } else if (seen.current) {
      // deleted on another device: a save now would bring it back, so leave it be
      saver.abandon()
      handlers.current.onBack()
    }
  }, [stored, saver])

  const hasText = hasNoteText(draft.body)
  const blank = !draft.title.trim() && !hasText
  const status = blank
    ? inStore
      ? 'Not saved while it is empty'
      : 'Saves once it has a title or some text'
    : dirty
      ? 'Saving…'
      : savedAt
        ? `Saved ${timeAgo(savedAt)}`
        : 'Autosaves as you type'
  // an archived project stays in the list while a note is about it, so the chip never reads wrong
  const about = projects.filter(p => p.status !== 'archived' || p.id === draft.projectId)
  const gone = !!draft.projectId && !projects.some(p => p.id === draft.projectId)

  return (
    <div className="notes-page note-page" ref={page}>
      <header className="notes-page-head note-head">
        <button
          type="button"
          className="btn subtle notes-back"
          onClick={() => {
            saver.flush()
            onBack()
          }}
        >
          All notes
        </button>
        <span className="spacer" />
        <button
          type="button"
          className={draft.pinned ? 'btn subtle note-pin on' : 'btn subtle note-pin'}
          title={draft.pinned ? 'Stop keeping it at the top of Notes' : 'Keep it at the top of Notes'}
          onClick={() => edit({ pinned: !draft.pinned }, true)}
        >
          {draft.pinned ? '📌 Unpin' : '📌 Pin'}
        </button>
        {onDelete && inStore && (
          <ConfirmButton
            className="btn subtle danger"
            title="Move this note to Trash, where it can be restored"
            onConfirm={() => {
              saver.remove()
              onBack()
            }}
          >
            Delete
          </ConfirmButton>
        )}
      </header>
      <input
        className="note-title-input"
        aria-label="Note title"
        placeholder={hasText ? UNTITLED : 'Title'}
        value={draft.title}
        maxLength={200}
        autoFocus={isNew}
        onChange={e => edit({ title: e.target.value })}
        onKeyDown={e => {
          // Enter moves on to the text, as a title field does in any notes app
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            page.current?.querySelector<HTMLElement>('.notes-editable')?.focus()
          }
        }}
      />
      <div className="note-about-row">
        <label className="note-about">
          <span>About</span>
          <select value={draft.projectId ?? ''} onChange={e => edit({ projectId: e.target.value || undefined }, true)}>
            <option value="">No project</option>
            {about.map(p => (
              <option key={p.id} value={p.id}>
                {`${p.emoji ? `${p.emoji} ` : ''}${p.name}`}
              </option>
            ))}
            {gone && <option value={draft.projectId}>A deleted project</option>}
          </select>
        </label>
      </div>
      <RichNotes value={draft.body} onChange={body => edit({ body })} status={status} onCreateTask={title => onCreateTask(title, draft.projectId ?? '')} />
    </div>
  )
}
