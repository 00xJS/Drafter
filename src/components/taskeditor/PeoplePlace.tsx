import { useState } from 'react'
import { SetForm, TaskForm } from '../../taskform'
import { PROJECT_COLORS, Person, Place } from '../../types'
import { uid } from '../../utils'
import { PeoplePicker } from '../PeoplePicker'

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
  const [placeQuery, setPlaceQuery] = useState('')

  return (
    <>
      <PeoplePicker
        peopleIds={peopleIds}
        onChange={update => set(f => ({ peopleIds: update(f.peopleIds) }))}
        people={people}
        onSavePerson={onSavePerson}
        hint="marking this done counts as seeing them"
        noun="task"
      />

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
