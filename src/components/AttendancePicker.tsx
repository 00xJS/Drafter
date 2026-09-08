import { useMemo, useState } from 'react'
import { CalendarEvent, PROJECT_COLORS, Person, Place } from '../types'
import { matchPlace } from '../places'
import { uid } from '../utils'

interface Props {
  event: CalendarEvent
  people: Person[]
  places?: Place[]
  /** Persist a place created from the event's location. */
  onSavePlace?(p: Place): void
  onDone(peopleIds: string[], placeId?: string): void
  onClose(): void
}

/**
 * "Who was there?" — tick the people at a past calendar event; each gets a
 * visit logged. If the event's location matches a saved place it is attached
 * too, and an unknown location can be saved as a place in the same tap.
 */
export function AttendancePicker({ event, people, places = [], onSavePlace, onDone, onClose }: Props) {
  const [ids, setIds] = useState<string[]>([])
  const matched = useMemo(() => matchPlace(event.location, places), [event.location, places])
  const [placeId, setPlaceId] = useState<string | undefined>(matched?.id)
  const [saveLocation, setSaveLocation] = useState(false)
  const canSaveLocation = !!event.location && !matched && !!onSavePlace
  const place = placeId ? places.find(p => p.id === placeId) : undefined

  const finish = () => {
    let chosen = placeId
    if (saveLocation && canSaveLocation) {
      const now = new Date().toISOString()
      const created: Place = {
        kind: 'place',
        id: uid(),
        name: event.location!.split(',')[0].trim().slice(0, 80) || event.location!.slice(0, 80),
        color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
        category: 'other',
        notes: event.location!.includes(',') ? event.location : undefined,
        createdAt: now,
        updatedAt: now,
      }
      onSavePlace!(created)
      chosen = created.id
    }
    onDone(ids, chosen)
  }

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
          {(place || matched || canSaveLocation) && (
            <div className="field">
              <span>Where</span>
              {place ? (
                <div className="platform-toggles attendees">
                  <button type="button" className="toggle on" onClick={() => setPlaceId(undefined)} title="Don't attach this place">
                    {place.emoji ? `${place.emoji} ` : ''}
                    {place.name} ✕
                  </button>
                  {matched && <small className="field-hint">Matched from “{event.location}”</small>}
                </div>
              ) : matched ? (
                <div className="platform-toggles attendees">
                  <button type="button" className="toggle" onClick={() => setPlaceId(matched.id)} title="Attach this place again">
                    {matched.emoji ? `${matched.emoji} ` : ''}
                    Attach {matched.name}
                  </button>
                </div>
              ) : (
                <label className="cal-source mirror-row">
                  <input type="checkbox" checked={saveLocation} onChange={e => setSaveLocation(e.target.checked)} />
                  <span className="cal-source-name">Save “{event.location}” as a place</span>
                </label>
              )}
            </div>
          )}
          <p className="field-hint">Each ticked person gets a visit logged on the event's date, so People stays accurate without extra typing. A place counts as an outing there.</p>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={ids.length === 0 && !placeId && !(saveLocation && canSaveLocation)} onClick={finish}>
            {ids.length ? `Log ${ids.length} ${ids.length === 1 ? 'person' : 'people'}` : 'Log the outing'}
          </button>
        </footer>
      </div>
    </div>
  )
}
