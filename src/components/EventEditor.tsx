import { useState } from 'react'
import { CalendarEntry } from '../types'
import { newerStamp } from '../itemops'
import { uid } from '../utils'

// The one thing a task cannot express: a block of time with a start AND an end.
// Everything else on the calendar marks a moment (a due time, a meal, an
// occasion); this reserves a slot.

/** 'YYYY-MM-DDTHH:MM' in local time, which is what <input type="datetime-local"> speaks. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function fromLocalInput(v: string): string | null {
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/** The day after a YYYY-MM-DD key. All-day ends are exclusive, per the ICS convention. */
function nextDayKey(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return key
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const dayKeyOf = (iso: string) => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.slice(0, 10)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function EventEditor({
  entry,
  defaultStartIso,
  onSave,
  onDelete,
  onClose,
}: {
  /** Editing an existing entry, or undefined to create one. */
  entry?: CalendarEntry
  /** The slot the calendar was showing when this opened. */
  defaultStartIso: string
  onSave(e: CalendarEntry): void
  onDelete?(id: string): void
  onClose(): void
}) {
  const [title, setTitle] = useState(entry?.title ?? '')
  const [allDay, setAllDay] = useState(entry?.allDay ?? false)
  const [startLocal, setStartLocal] = useState(() => toLocalInput(entry && !entry.allDay ? entry.start : defaultStartIso))
  const [endLocal, setEndLocal] = useState(() =>
    toLocalInput(entry && !entry.allDay ? entry.end : new Date(Date.parse(defaultStartIso) + 3_600_000).toISOString()),
  )
  const [startDay, setStartDay] = useState(() => (entry?.allDay ? entry.start : dayKeyOf(entry?.start ?? defaultStartIso)))
  const [location, setLocation] = useState(entry?.location ?? '')
  const [notes, setNotes] = useState(entry?.notes ?? '')
  const [error, setError] = useState('')

  const save = () => {
    const name = title.trim()
    if (!name) {
      setError('Give it a title.')
      return
    }
    let start: string
    let end: string
    if (allDay) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay)) {
        setError('Pick a day.')
        return
      }
      start = startDay
      end = nextDayKey(startDay)
    } else {
      const s = fromLocalInput(startLocal)
      const e = fromLocalInput(endLocal)
      if (!s) {
        setError('Pick a start time.')
        return
      }
      // An end before the start would draw a backwards block. Say so rather
      // than silently repairing it — the user picked both.
      if (e && Date.parse(e) <= Date.parse(s)) {
        setError('The end has to be after the start.')
        return
      }
      start = s
      end = e ?? new Date(Date.parse(s) + 3_600_000).toISOString()
    }
    const now = new Date().toISOString()
    onSave({
      kind: 'event',
      id: entry?.id ?? uid(),
      title: name,
      start,
      end,
      allDay,
      location: location.trim() || undefined,
      notes: notes.trim() || undefined,
      projectId: entry?.projectId,
      peopleIds: entry?.peopleIds,
      createdAt: entry?.createdAt ?? now,
      updatedAt: entry ? newerStamp(entry.updatedAt) : now,
    })
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal event-modal" role="dialog" aria-modal="true" aria-label={entry ? 'Edit event' : 'New event'}>
        <header className="modal-head">
          <h2>{entry ? 'Edit event' : 'New event'}</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <label className="field">
            <span>Title</span>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') save()
              }}
              placeholder="Dentist"
            />
          </label>

          <label className="field-inline">
            <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />
            <span>All day</span>
          </label>

          {allDay ? (
            <label className="field">
              <span>Day</span>
              <input type="date" value={startDay} onChange={e => setStartDay(e.target.value)} />
            </label>
          ) : (
            <>
              <label className="field">
                <span>Starts</span>
                <input type="datetime-local" value={startLocal} onChange={e => setStartLocal(e.target.value)} />
              </label>
              <label className="field">
                <span>Ends</span>
                <input type="datetime-local" value={endLocal} onChange={e => setEndLocal(e.target.value)} />
              </label>
            </>
          )}

          <label className="field">
            <span>Location</span>
            <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Optional" />
          </label>

          <label className="field">
            <span>Notes</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Optional" />
          </label>

          {error && <p className="form-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          {entry && onDelete && (
            <button
              className="btn danger"
              onClick={() => {
                onDelete(entry.id)
                onClose()
              }}
            >
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn subtle" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}
