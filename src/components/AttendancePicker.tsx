import { useMemo, useState } from 'react'
import { CalendarEvent, PROJECT_COLORS, Person, Place, PlaceCategory } from '../types'
import { matchPlace, newPlace, placeByName } from '../places'
import { newPerson } from '../taskform'
import { uid } from '../utils'
import { Modal, ModalHead } from './Modal'
import { PlaceKindChooser } from './PlaceKindChooser'

interface Props {
  event: CalendarEvent
  people: Person[]
  places?: Place[]
  /** Persist a place saved from the event's location. */
  onSavePlace?(p: Place): void
  /** Persist someone added by name who isn't in People yet. */
  onSavePerson?(p: Person): void
  onDone(peopleIds: string[], placeId?: string): void
  onClose(): void
}

const randomColor = () => PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]

/**
 * The person a typed name means: someone already saved (any case, any
 * spacing) — so typing "mum" twice never makes two Mums — or a new one.
 */
export function attendeeFor(name: string, people: Person[], create: (name: string) => Person): { person: Person; created: boolean } | null {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) return null
  const key = clean.toLowerCase()
  const existing = people.find(p => p.name.trim().replace(/\s+/g, ' ').toLowerCase() === key)
  return existing ? { person: existing, created: false } : { person: create(clean), created: true }
}

/** The name a place saved from an event's location gets: the venue, before the address. */
export function locationPlaceName(location: string): string {
  return location.split(',')[0].trim().slice(0, 80) || location.trim().slice(0, 80)
}

/**
 * The saved place an event's location means: one whose name it holds
 * (matchPlace), else one named just what the location opens with — 東京 in
 * "東京, Shibuya", which matchPlace's a–z key cannot see — so a place you have
 * is attached as it always was, never offered to be saved a second time.
 */
export function placeAtLocation(location: string | undefined, places: Place[]): Place | undefined {
  if (!location?.trim()) return undefined
  return matchPlace(location, places) ?? placeByName(locationPlaceName(location), places)
}

/** An event's location saved as a place of the kind you picked: named for the venue, the full address kept in its notes. */
export function placeFromLocation(location: string, kind: PlaceCategory, opts: { id: string; color: string; now: Date }): Place {
  return newPlace(locationPlaceName(location), kind, { ...opts, notes: location.includes(',') ? location.trim() : undefined })
}

/**
 * Whether Log can go: someone ticked or a place attached, and — with Save
 * “…” as a place ticked — a kind picked for it. Ticked Save with no kind
 * holds Log back, rather than save the place under a kind nobody chose or
 * quietly leave it unsaved.
 */
export function canLogAttendance(o: { people: number; placeId?: string; saving: boolean; kind?: PlaceCategory }): boolean {
  if (o.saving) return !!o.kind
  return o.people > 0 || !!o.placeId
}

/**
 * Save “<location>” as a place: never ticked for you, and once ticked it asks
 * what kind of place it is. Holds no state, so the picker owns both answers.
 */
export function SaveLocation({
  location,
  checked,
  kind,
  onCheck,
  onKind,
}: {
  location: string
  checked: boolean
  kind?: PlaceCategory
  onCheck(on: boolean): void
  onKind(kind: PlaceCategory): void
}) {
  const name = locationPlaceName(location)
  return (
    <>
      <label className="cal-source mirror-row">
        <input type="checkbox" checked={checked} onChange={e => onCheck(e.target.checked)} />
        <span className="cal-source-name">Save “{location}” as a place</span>
      </label>
      {checked && (
        <div className="place-new">
          <small className="place-new-ask">What kind of place is “{name}”?</small>
          <PlaceKindChooser value={kind} onChange={onKind} label={`Kind of place for “${name}”`} />
        </div>
      )}
    </>
  )
}

/**
 * "Who was there?" — tick the people at a past calendar event; each gets a
 * visit logged. If the event's location matches a saved place it is attached
 * too. An unknown location is saved as a place only if you tick Save and say
 * what kind of place it is — never by itself.
 */
export function AttendancePicker({ event, people, places = [], onSavePlace, onSavePerson, onDone, onClose }: Props) {
  const [ids, setIds] = useState<string[]>([])
  const [newName, setNewName] = useState('')
  const addSomeone = () => {
    const hit = attendeeFor(newName, people, name => newPerson(name, { id: uid(), color: randomColor(), now: new Date() }))
    if (!hit) return
    if (hit.created) onSavePerson?.(hit.person)
    setIds(cur => (cur.includes(hit.person.id) ? cur : [...cur, hit.person.id]))
    setNewName('')
  }
  const matched = useMemo(() => placeAtLocation(event.location, places), [event.location, places])
  const [placeId, setPlaceId] = useState<string | undefined>(matched?.id)
  const [saveLocation, setSaveLocation] = useState(false)
  const [kind, setKind] = useState<PlaceCategory | undefined>()
  const canSaveLocation = !!event.location?.trim() && !matched && !!onSavePlace
  const saving = saveLocation && canSaveLocation
  const place = placeId ? places.find(p => p.id === placeId) : undefined
  const canLog = canLogAttendance({ people: ids.length, placeId, saving, kind })

  const finish = () => {
    if (!canLog) return
    let chosen = placeId
    if (saving && kind) {
      const created = placeFromLocation(event.location!, kind, { id: uid(), color: randomColor(), now: new Date() })
      onSavePlace!(created)
      chosen = created.id
    }
    onDone(ids, chosen)
  }

  return (
    <Modal onClose={onClose} className="modal narrow">
      <ModalHead title={`Who was at “${event.title}”?`} />
      <div className="modal-body">
        {people.length === 0 && !onSavePerson ? (
          <p className="empty">Add people in the People tab first.</p>
        ) : (
          <>
            {people.length > 0 && (
              <div className="platform-toggles">
                {people.map(p => (
                  <button key={p.id} type="button" className={ids.includes(p.id) ? 'toggle on' : 'toggle'} onClick={() => setIds(cur => (cur.includes(p.id) ? cur.filter(x => x !== p.id) : [...cur, p.id]))}>
                    {p.emoji ? `${p.emoji} ` : ''}
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            {onSavePerson && (
              // someone who isn't in People yet: typing their name adds them and ticks them
              <div className="copy-row attendee-add">
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addSomeone()
                    }
                  }}
                  placeholder="Someone else? Type their name"
                  aria-label="Add someone who was there"
                />
                <button type="button" className="btn" onClick={addSomeone} disabled={!newName.trim()}>
                  Add
                </button>
              </div>
            )}
          </>
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
              <SaveLocation
                location={event.location!}
                checked={saveLocation}
                kind={kind}
                onCheck={on => {
                  setSaveLocation(on)
                  if (!on) setKind(undefined)
                }}
                onKind={setKind}
              />
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
        <button className="btn primary" disabled={!canLog} onClick={finish}>
          {ids.length ? `Log ${ids.length} ${ids.length === 1 ? 'person' : 'people'}` : 'Log the outing'}
        </button>
      </footer>
    </Modal>
  )
}
