import { useState } from 'react'
import { SetForm, TaskForm, newPerson, peopleSearch } from '../../taskform'
import { PROJECT_COLORS, Person, Place } from '../../types'
import { uid } from '../../utils'

interface Props {
  form: Pick<TaskForm, 'peopleIds' | 'placeId'>
  set: SetForm
  people: Person[]
  places: Place[]
  onSavePlace?(p: Place): void
  /** Save someone typed here who isn't in People yet. Without it the picker only finds people. */
  onSavePerson?(p: Person): void
}

const randomColor = () => PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]

/** Who the task involves (anyone new can be added by name), and where it happens. */
export function PeoplePlace({ form, set, people, places, onSavePlace, onSavePerson }: Props) {
  const { peopleIds, placeId } = form
  const [peopleQuery, setPeopleQuery] = useState('')
  const [placeQuery, setPlaceQuery] = useState('')
  // people added here, until the store hands them back in `people`: a chip never
  // reads "Unknown", and a second Add of the same name finds the first
  const [added, setAdded] = useState<Person[]>([])
  const everyone = [...people, ...added.filter(a => !people.some(p => p.id === a.id))]

  const { name, exact, matches } = peopleSearch(peopleQuery, everyone, peopleIds)
  const canAddPerson = !!onSavePerson && !!name && !exact

  function attach(p: Person) {
    set(f => ({ peopleIds: f.peopleIds.includes(p.id) ? f.peopleIds : [...f.peopleIds, p.id] }))
    setPeopleQuery('')
  }

  function addPerson() {
    if (!canAddPerson) return
    const p = newPerson(name, { id: uid(), color: randomColor(), now: new Date() })
    onSavePerson!(p)
    setAdded(a => [...a, p])
    attach(p)
  }

  return (
    <>
      {(people.length > 0 || onSavePerson) && (
        <div className="field">
          <span>
            People <small>(marking this done counts as seeing them)</small>
          </span>
          {/* only who is actually attached is listed; the rest are found by
              typing, so a long contact list never fills the editor */}
          {peopleIds.length > 0 && (
            <div className="platform-toggles attendees">
              {peopleIds.map(id => {
                const p = everyone.find(x => x.id === id)
                return (
                  <button key={id} type="button" className="toggle on" onClick={() => set(f => ({ peopleIds: f.peopleIds.filter(x => x !== id) }))} title="Remove">
                    {p?.emoji ? `${p.emoji} ` : ''}
                    {p?.name ?? 'Unknown'} ✕
                  </button>
                )
              })}
            </div>
          )}
          <input
            className="people-picker-search"
            value={peopleQuery}
            onChange={e => setPeopleQuery(e.target.value)}
            placeholder={peopleIds.length ? 'Add someone else…' : onSavePerson ? 'Search or add a person…' : 'Search people to add…'}
            onKeyDown={e => {
              if (e.key !== 'Enter' || !name) return
              e.preventDefault()
              // the exact name first, so Enter never adds someone who is already there
              if (exact) {
                if (!peopleIds.includes(exact.id)) attach(exact)
              } else if (canAddPerson) addPerson()
              else if (matches[0]) attach(matches[0])
            }}
          />
          {name && (
            <div className="platform-toggles picker-results">
              {matches.map(p => (
                <button key={p.id} type="button" className="toggle" onClick={() => attach(p)}>
                  {p.emoji ? `${p.emoji} ` : ''}
                  {p.name}
                </button>
              ))}
              {canAddPerson && (
                <button type="button" className="toggle add-person" onClick={addPerson}>
                  + Add ‘{name}’ as a new person
                </button>
              )}
              {exact && peopleIds.includes(exact.id) && matches.length === 0 && <small className="muted">{exact.name} is already on this task.</small>}
              {!canAddPerson && !exact && matches.length === 0 && <small className="muted">No match.</small>}
            </div>
          )}
        </div>
      )}

      <div className="field">
        <span>
          Where <small>(marking this done counts as an outing there)</small>
        </span>
        {placeId && (
          <div className="platform-toggles attendees">
            {(() => {
              const p = places.find(x => x.id === placeId)
              return (
                <button type="button" className="toggle on" onClick={() => set({ placeId: undefined })} title="Remove">
                  {p?.emoji ? `${p.emoji} ` : ''}
                  {p?.name ?? 'Unknown'} ✕
                </button>
              )
            })()}
          </div>
        )}
        {!placeId && (
          <>
            <input
              className="people-picker-search"
              value={placeQuery}
              onChange={e => setPlaceQuery(e.target.value)}
              placeholder="Search places…"
            />
            {placeQuery.trim() && (
              <div className="platform-toggles picker-results">
                {places
                  .filter(p => p.name.toLowerCase().includes(placeQuery.trim().toLowerCase()))
                  .slice(0, 8)
                  .map(p => (
                    <button
                      key={p.id}
                      type="button"
                      className="toggle"
                      onClick={() => {
                        set({ placeId: p.id })
                        setPlaceQuery('')
                      }}
                    >
                      {p.emoji ? `${p.emoji} ` : ''}
                      {p.name}
                    </button>
                  ))}
                {onSavePlace &&
                  !places.some(p => p.name.toLowerCase() === placeQuery.trim().toLowerCase()) && (
                    <button
                      type="button"
                      className="toggle"
                      onClick={() => {
                        const now = new Date().toISOString()
                        const p: Place = {
                          kind: 'place',
                          id: uid(),
                          name: placeQuery.trim(),
                          color: randomColor(),
                          category: 'other',
                          createdAt: now,
                          updatedAt: now,
                        }
                        onSavePlace(p)
                        set({ placeId: p.id })
                        setPlaceQuery('')
                      }}
                    >
                      Create place “{placeQuery.trim()}”
                    </button>
                  )}
                {!onSavePlace &&
                  places.filter(p => p.name.toLowerCase().includes(placeQuery.trim().toLowerCase())).length === 0 && (
                    <small className="muted">No match.</small>
                  )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
