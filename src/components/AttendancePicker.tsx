import { useState } from 'react'
import { CalendarEvent, Person } from '../types'

interface Props {
  event: CalendarEvent
  people: Person[]
  onDone(peopleIds: string[]): void
  onClose(): void
}

/** "Who was there?" — tick the people at a past calendar event; each gets a visit logged. */
export function AttendancePicker({ event, people, onDone, onClose }: Props) {
  const [ids, setIds] = useState<string[]>([])
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Who was at “{event.title}”?</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">
          {people.length === 0 ? (
            <p className="empty">Add people in the People tab first.</p>
          ) : (
            <div className="platform-toggles">
              {people.map(p => (
                <button key={p.id} type="button" className={ids.includes(p.id) ? 'toggle on' : 'toggle'} onClick={() => setIds(cur => (cur.includes(p.id) ? cur.filter(x => x !== p.id) : [...cur, p.id]))}>
                  {p.emoji ? `${p.emoji} ` : ''}
                  {p.name}
                </button>
              ))}
            </div>
          )}
          <p className="field-hint">Each ticked person gets a visit logged on the event's date, so People stays accurate without extra typing.</p>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={ids.length === 0} onClick={() => onDone(ids)}>
            Log {ids.length || ''} {ids.length === 1 ? 'person' : 'people'}
          </button>
        </footer>
      </div>
    </div>
  )
}
