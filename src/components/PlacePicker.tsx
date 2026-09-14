import { useState } from 'react'
import { newPlace, placeSearch } from '../places'
import { PROJECT_COLORS, Place, PlaceCategory } from '../types'
import { uid } from '../utils'
import { PlaceKindChooser } from './PlaceKindChooser'

interface Props {
  placeId?: string
  onChange(placeId: string | undefined): void
  places: Place[]
  /** Save a place typed here that isn't saved yet. Without it the picker only finds places. */
  onSavePlace?(p: Place): void
  label: string
  /** What choosing a place counts as, beside the label. */
  hint?: string
}

const randomColor = () => PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]

/**
 * What Enter does with the name typed: the saved place it already means
 * (however it is spelled, see placeSearch) first, so Enter never makes a
 * second copy; else a new place, when the picker can save one; else the first
 * match. Null when it does nothing.
 */
export function enterPlace(query: string, places: readonly Place[], canCreate: boolean): { pick: Place } | { create: string } | null {
  const { name, exact, matches } = placeSearch(query, places)
  if (!name) return null
  if (exact) return { pick: exact }
  if (canCreate) return { create: name }
  return matches[0] ? { pick: matches[0] } : null
}

/**
 * Asked before somewhere new is saved: what kind of place it is. Create place
 * waits for the answer — there is no kind to fall back on — and Cancel goes
 * back to the search. It holds no state, so the picker owns the answer.
 */
export function NewPlaceStep({
  name,
  kind,
  onKind,
  onCreate,
  onCancel,
}: {
  name: string
  kind?: PlaceCategory
  onKind(kind: PlaceCategory): void
  onCreate(kind: PlaceCategory): void
  onCancel(): void
}) {
  return (
    <div className="place-new" role="group" aria-label={`New place “${name}”`}>
      <small className="place-new-ask">What kind of place is “{name}”?</small>
      <PlaceKindChooser value={kind} onChange={onKind} label={`Kind of place for “${name}”`} />
      <div className="place-new-actions">
        <button type="button" className="btn primary" disabled={!kind} onClick={() => kind && onCreate(kind)}>
          Create place
        </button>
        <button type="button" className="btn subtle" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * Where something happened or will: found by typing, and somewhere new saved
 * from its name once you say what kind of place it is. One picker for the task
 * editor's Where and Saw them's, so both reuse a saved place the way the meal
 * picker does — and a saved place is chosen without being asked anything.
 */
export function PlacePicker({ placeId, onChange, places, onSavePlace, label, hint }: Props) {
  const [query, setQuery] = useState('')
  // places made here, until the store hands them back in `places`: the chip
  // never reads "Unknown", and typing the same name again finds the first
  const [added, setAdded] = useState<Place[]>([])
  // somewhere new waits here for its kind: asking once New place is chosen,
  // and the kind once one is picked — never a default
  const [asking, setAsking] = useState(false)
  const [kind, setKind] = useState<PlaceCategory | undefined>()
  const everyone = [...places, ...added.filter(a => !places.some(p => p.id === a.id))]

  const { name, matches } = placeSearch(query, everyone)
  // "New place" is offered exactly when Enter would create one
  const pick = enterPlace(query, everyone, !!onSavePlace)
  const canCreate = !!pick && 'create' in pick

  function stopAsking() {
    setAsking(false)
    setKind(undefined)
  }

  function choose(p: Place) {
    onChange(p.id)
    setQuery('')
    stopAsking()
  }

  function create(category: PlaceCategory) {
    if (!canCreate) return
    const p = newPlace(name, category, { id: uid(), color: randomColor(), now: new Date() })
    onSavePlace!(p)
    setAdded(a => [...a, p])
    choose(p)
  }

  const selected = placeId ? everyone.find(p => p.id === placeId) : undefined
  return (
    <div className="field">
      <span>
        {label}
        {hint && (
          <>
            {' '}
            <small>({hint})</small>
          </>
        )}
      </span>
      {placeId ? (
        <div className="platform-toggles attendees">
          <button type="button" className="toggle on" onClick={() => onChange(undefined)} title="Remove">
            {selected?.emoji ? `${selected.emoji} ` : ''}
            {selected?.name ?? 'Unknown'} ✕
          </button>
        </div>
      ) : (
        <>
          <input
            className="people-picker-search"
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              // emptied, or now a saved place: nothing to ask, and a kind picked
              // for the last new name is not carried to the next one
              const next = enterPlace(e.target.value, everyone, !!onSavePlace)
              if (!next || !('create' in next)) stopAsking()
            }}
            placeholder="Search places…"
            onKeyDown={e => {
              if (e.key !== 'Enter' || !name) return
              e.preventDefault()
              if (!pick) return
              if ('pick' in pick) choose(pick.pick)
              // somewhere new: the first Enter asks its kind, the next saves it once one is picked
              else if (asking && kind) create(kind)
              else setAsking(true)
            }}
          />
          {name && (
            <div className="platform-toggles picker-results">
              {matches.map(p => (
                <button key={p.id} type="button" className="toggle" onClick={() => choose(p)}>
                  {p.emoji ? `${p.emoji} ` : ''}
                  {p.name}
                </button>
              ))}
              {canCreate && !asking && (
                <button type="button" className="toggle" onClick={() => setAsking(true)}>
                  New place “{name}”…
                </button>
              )}
              {!canCreate && matches.length === 0 && <small className="muted">No match.</small>}
            </div>
          )}
          {canCreate && asking && <NewPlaceStep name={name} kind={kind} onKind={setKind} onCreate={create} onCancel={stopAsking} />}
        </>
      )}
    </div>
  )
}
