import { useEffect, useMemo, useState } from 'react'
import { PLACE_CATEGORY_META, type Person, type Place } from '../types'
import { formatDistance, HERE_METERS, nearbyPlaces, requestDevicePosition, type Coord } from '../geo'
import { Modal, ModalHead } from './Modal'
import { PlacePicker } from './PlacePicker'

interface Props {
  places: Place[]
  people: Person[]
  onLog(place: Place, peopleIds: string[], note: string, here: Coord | null): void
  onSavePlace(p: Place): void
  onClose(): void
  /** Tests pass a locator; the sheet asks the device when this is left off. */
  locate?: () => Promise<Coord | null>
  /** Skip the ask and start with these coordinates. */
  here?: Coord | null
}

/**
 * I'm here: log where you are standing, and who you are with. Nearby saved
 * places (a pin within 400 m) are offered first; any place can be picked;
 * solo is fine. The first log at a place without a pin keeps this spot so
 * the next visit finds it.
 */
export function ImHereSheet({ places, people, onLog, onSavePlace, onClose, locate = requestDevicePosition, here: given }: Props) {
  const [locating, setLocating] = useState(given === undefined)
  const [here, setHere] = useState<Coord | null>(given ?? null)
  const [placeId, setPlaceId] = useState<string | undefined>()
  const [ids, setIds] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [withAll, setWithAll] = useState(false)

  useEffect(() => {
    if (given !== undefined) return
    let gone = false
    locate().then(pos => {
      if (gone) return
      setHere(pos)
      setLocating(false)
    })
    return () => {
      gone = true
    }
  }, [given, locate])

  const nearby = useMemo(() => (here ? nearbyPlaces(places, here) : []), [places, here])
  const closest = nearby[0]
  const autoId = closest && closest.meters <= HERE_METERS ? closest.place.id : undefined
  const chosenId = placeId ?? autoId
  const chosen = places.find(p => p.id === chosenId)

  const company = useMemo(
    () => [...people].sort((a, b) => a.name.localeCompare(b.name)),
    [people],
  )
  const usual = company.slice(0, 6)
  const shown = withAll ? company : company.filter(p => usual.includes(p) || ids.includes(p.id))

  const savePlace = (p: Place) => {
    const pinned = here && p.lat == null && p.lon == null ? { ...p, lat: here.lat, lon: here.lon } : p
    onSavePlace(pinned)
  }

  return (
    <Modal onClose={onClose} className="modal narrow">
      <ModalHead title="I'm here" variant="compose">
        <button
          type="button"
          className="btn primary"
          disabled={!chosen}
          onClick={() => chosen && onLog(chosen, ids, note.trim(), here)}
        >
          Log it
        </button>
      </ModalHead>
      <div className="modal-body">
        <p className="field-hint">Log where you are, and who you are with. Solo is fine.</p>
        <p className="field-hint">
          {locating
            ? 'Finding you…'
            : here
              ? nearby.length
                ? 'These of yours are nearby.'
                : 'None of your places are nearby yet — pick one and the next visit will know.'
              : 'Location is off — pick the place.'}
        </p>

        {nearby.length > 0 && (
          <div className="field">
            <span>Nearby</span>
            <div className="platform-toggles">
              {nearby.map(({ place, meters }) => (
                <button
                  key={place.id}
                  type="button"
                  className={chosenId === place.id ? 'toggle on' : 'toggle'}
                  aria-pressed={chosenId === place.id}
                  onClick={() => setPlaceId(place.id)}
                >
                  {place.emoji ? `${place.emoji} ` : PLACE_CATEGORY_META[place.category].emoji + ' '}
                  {place.name}
                  <small className="muted"> {formatDistance(meters)}</small>
                </button>
              ))}
            </div>
          </div>
        )}

        <PlacePicker
          placeId={placeId}
          onChange={setPlaceId}
          places={places}
          onSavePlace={savePlace}
          label={nearby.length ? 'Or another place' : 'Where are you?'}
        />

        {people.length > 0 && (
          <div className="field">
            <span>Who are you with?</span>
            <div className="platform-toggles">
              {shown.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={ids.includes(p.id) ? 'toggle on' : 'toggle'}
                  aria-pressed={ids.includes(p.id)}
                  onClick={() => setIds(cur => (cur.includes(p.id) ? cur.filter(x => x !== p.id) : [...cur, p.id]))}
                >
                  {p.emoji ? `${p.emoji} ` : ''}
                  {p.name}
                </button>
              ))}
              {(withAll || shown.length < company.length) && (
                <button type="button" className="btn subtle" onClick={() => setWithAll(v => !v)} aria-expanded={withAll}>
                  {withAll ? 'Hide' : '+ Who'}
                </button>
              )}
            </div>
          </div>
        )}

        <label className="field">
          <span>
            What are you doing? <small>(optional)</small>
          </span>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Dinner, coffee, a walk…" />
        </label>
      </div>
    </Modal>
  )
}
