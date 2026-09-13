import { useState } from 'react'
import { AiBusy, StepOp } from '../../taskform'
import { ChecklistItem } from '../../types'

interface Props {
  checklist: ChecklistItem[]
  /** A step's text as it is typed; the rename itself is sent when the field is left. */
  onType(id: string, text: string): void
  /** Tick, rename or remove a step. On a saved task each is written at once. */
  onStep(op: StepOp): void
  /** Append steps (the ✨ breakdown appends through this too). */
  addChecks(texts: string[]): void
  title: string
  description: string
  aiBusy: AiBusy
  onBreakDown(): void
}

/** The checklist: tick, edit and remove steps, add one, or ✨ break the task down. */
export function ChecklistField({ checklist, onType, onStep, addChecks, title, description, aiBusy, onBreakDown }: Props) {
  const [newCheck, setNewCheck] = useState('')

  const addCheck = () => {
    const text = newCheck.trim()
    if (!text) return
    addChecks([text])
    setNewCheck('')
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
            <input type="checkbox" checked={c.done} onChange={e => onStep({ type: 'tick', id: c.id, done: e.target.checked })} aria-label="Done" />
            <input
              className="check-text"
              value={c.text}
              aria-label="Step"
              onChange={e => onType(c.id, e.target.value)}
              onBlur={() => onStep({ type: 'rename', id: c.id, text: c.text })}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
            />
            <button type="button" className="btn subtle" aria-label="Remove" onClick={() => onStep({ type: 'remove', id: c.id })}>
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
