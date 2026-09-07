import { useEffect, useRef, useState } from 'react'
import { Project } from '../types'
import { newerStamp } from '../itemops'
import { timeAgo } from '../utils'
import { NotesEditor } from './NotesEditor'

interface Props {
  project: Project
  getLatest(id: string): Project | undefined
  onSave(p: Project): void
  onClose(): void
}

/** Full-width notes pad for a project. Autosaves as you type (debounced). */
export function ProjectNotes({ project, getLatest, onSave, onClose }: Props) {
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

  // save when the tab goes to the background and on unmount
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

  const close = () => {
    persist()
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="modal wide notes-modal" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>
            <span className="pdot" style={{ background: project.color }} /> {project.emoji ? `${project.emoji} ` : ''}
            {project.name} · Notes
          </h2>
          <button className="btn subtle" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body notes-modal-body">
          <NotesEditor value={text} onChange={change} autoFocus status={dirty ? 'Saving…' : savedAt ? `Saved ${timeAgo(savedAt)}` : 'Autosaves as you type'} />
        </div>
      </div>
    </div>
  )
}
