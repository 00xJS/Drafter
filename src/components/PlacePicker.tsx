import { useState } from 'react'
import { placeSearch } from '../places'
import { PROJECT_COLORS, Place } from '../types'
import { uid } from '../utils'

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
 * Where something happened or will: found by typing, and somewhere new saved
 * from its name. One picker for the task editor's Where and Saw them's, so
 * both reuse a saved place the way the meal picker does.
 */
export function PlacePicker({ placeId, onChange, places, onSavePlace, label, hint }: Props) {
  const [query, setQuery] = useState('')
  // places made here, until the store hands them back in `places`: the chip
  // never reads "Unknown", and typing the same name again finds the first
  const [added, setAdded] = useState<Place[]>([])
  const everyone = [...places, ...added.filter(a => !places.some(p => p.id === a.id))]

  const { name, matches } = placeSearch(query, everyone)
  // "Create place" is offered exactly when Enter would create one
  const pick = enterPlace(query, everyone, !!onSavePlace)
  const canCreate = !!pick && 'create' in pick

  function choose(p: Place) {
    onChange(p.id)
    setQuery('')
  }

  function create() {
    if (!canCreate) return
    const now = new Date().toISOString()
    const p: Place = { kind: 'place', id: uid(), name, color: randomColor(), category: 'other', createdAt: now, updatedAt: now }
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
            onChange={e => setQuery(e.target.value)}
            placeholder="Search places…"
            onKeyDown={e => {
              if (e.key !== 'Enter' || !name) return
              e.preventDefault()
              if (!pick) return
              if ('create' in pick) create()
              else choose(pick.pick)
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
              {canCreate && (
                <button type="button" className="toggle" onClick={create}>
                  Create place “{name}”
                </button>
              )}
              {!canCreate && matches.length === 0 && <small className="muted">No match.</small>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
