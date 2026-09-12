import { useState } from 'react'
import { SetForm, TaskForm } from '../../taskform'
import { PROJECT_COLORS, Person, Place } from '../../types'
import { uid } from '../../utils'

interface Props {
  form: Pick<TaskForm, 'peopleIds' | 'placeId'>
  set: SetForm
  people: Person[]
  places: Place[]
  onSavePlace?(p: Place): void
}

/** Who the task involves, and where it happens. */
export function PeoplePlace({ form, set, people, places, onSavePlace }: Props) {
  const { peopleIds, placeId } = form
  const [peopleQuery, setPeopleQuery] = useState('')
  const [placeQuery, setPlaceQuery] = useState('')

  return (
    <>
      {people.length > 0 && (
        <div className="field">
          <span>
            People <small>(marking this done counts as seeing them)</small>
          </span>
          {/* only who is actually attached is listed; the rest are found by
              typing, so a long contact list never fills the editor */}
          {peopleIds.length > 0 && (
            <div className="platform-toggles attendees">
              {peopleIds.map(id => {
                const p = people.find(x => x.id === id)
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
            placeholder={peopleIds.length ? 'Add someone else…' : 'Search people to add…'}
          />
          {peopleQuery.trim() && (
            <div className="platform-toggles picker-results">
              {people
                .filter(p => !peopleIds.includes(p.id) && p.name.toLowerCase().includes(peopleQuery.trim().toLowerCase()))
                .slice(0, 8)
                .map(p => (
                  <button
                    key={p.id}
                    type="button"
                    className="toggle"
                    onClick={() => {
                      set(f => ({ peopleIds: [...f.peopleIds, p.id] }))
                      setPeopleQuery('')
                    }}
                  >
                    {p.emoji ? `${p.emoji} ` : ''}
                    {p.name}
                  </button>
                ))}
              {people.filter(p => !peopleIds.includes(p.id) && p.name.toLowerCase().includes(peopleQuery.trim().toLowerCase())).length === 0 && (
                <small className="muted">No match.</small>
              )}
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
                          color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
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
