import { useState } from 'react'
import { newerStamp } from '../../itemops'
import { AiBusy, SetForm } from '../../taskform'
import { ChecklistItem, Task } from '../../types'

interface Props {
  checklist: ChecklistItem[]
  set: SetForm
  /** Append steps (the ✨ breakdown appends through this too). */
  addChecks(texts: string[]): void
  /** A saved task: a tick is written at once, onto the freshest copy. */
  persisted: boolean
  latest(): Task
  onCommit(t: Task): void
  title: string
  description: string
  aiBusy: AiBusy
  onBreakDown(): void
}

/** The checklist: tick, edit and remove steps, add one, or ✨ break the task down. */
export function ChecklistField({ checklist, set, addChecks, persisted, latest, onCommit, title, description, aiBusy, onBreakDown }: Props) {
  const [newCheck, setNewCheck] = useState('')

  const addCheck = () => {
    const text = newCheck.trim()
    if (!text) return
    addChecks([text])
    setNewCheck('')
  }

  function toggleCheckItem(id: string, done: boolean) {
    const next = checklist.map(x => (x.id === id ? { ...x, done } : x))
    set({ checklist: next })
    if (persisted) {
      const current = latest()
      const cleaned = next.length > 0 ? next.map(c => ({ ...c, text: c.text.trim() })).filter(c => c.text) : undefined
      onCommit({ ...current, checklist: cleaned, updatedAt: newerStamp(current.updatedAt) })
    }
  }

  const checkDone = checklist.filter(c => c.done).length

  return (
    <div className="field">
      <span>
        Checklist {checklist.length > 0 && <small>({checkDone}/{checklist.length} done)</small>}
      </span>
      <ul className="checklist">
        {checklist.map(c => (
          <li key={c.id} className={c.done ? 'check-item done' : 'check-item'}>
            <input type="checkbox" checked={c.done} onChange={e => toggleCheckItem(c.id, e.target.checked)} aria-label="Done" />
            <input
              className="check-text"
              value={c.text}
              onChange={e => {
                const text = e.target.value
                set(f => ({ checklist: f.checklist.map(x => (x.id === c.id ? { ...x, text } : x)) }))
              }}
            />
            <button type="button" className="btn subtle" aria-label="Remove" onClick={() => set(f => ({ checklist: f.checklist.filter(x => x.id !== c.id) }))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="check-add">
        <input
          value={newCheck}
          onChange={e => setNewCheck(e.target.value)}
          placeholder="Add a step and press Enter"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addCheck()
            }
          }}
        />
        <button type="button" className="btn" onClick={addCheck}>
          Add
        </button>
        <button type="button" className="btn" disabled={(!title.trim() && !description.trim()) || aiBusy !== null} onClick={onBreakDown}>
          {aiBusy === 'checklist' ? 'Thinking…' : '✨ Break it down'}
        </button>
      </div>
    </div>
  )
}
