import { useState } from 'react'
import { newPerson, peopleSearch } from '../taskform'
import { PROJECT_COLORS, Person } from '../types'
import { uid } from '../utils'

interface Props {
  peopleIds: string[]
  /** A change to the ids as they stand when it lands, so two quick taps never undo each other. */
  onChange(update: (ids: string[]) => string[]): void
  people: Person[]
  /** Save someone typed here who isn't in People yet. Without it the picker only finds people. */
  onSavePerson?(p: Person): void
  /** What being on it counts as, beside the label. */
  hint: string
  /** What they are on, for "Sam is already on this task." */
  noun: 'task' | 'event'
}

const randomColor = () => PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]

/**
 * What Enter does with the name typed: the person of exactly that name (any
 * case or spacing) first, so Enter never adds someone who is already there;
 * else someone new, when the picker can save people; else the first match.
 * Null when it does nothing: an empty box, or a name already attached.
 */
export function enterPick(query: string, people: readonly Person[], attached: readonly string[], canAdd: boolean): { attach: Person } | { add: string } | null {
  const { name, exact, matches } = peopleSearch(query, people, attached)
  if (!name) return null
  if (exact) return attached.includes(exact.id) ? null : { attach: exact }
  if (canAdd) return { add: name }
  return matches[0] ? { attach: matches[0] } : null
}

/** Who a task or an event involves: found by typing, and anyone new added by name. */
export function PeoplePicker({ peopleIds, onChange, people, onSavePerson, hint, noun }: Props) {
  const [query, setQuery] = useState('')
  // people added here, until the store hands them back in `people`: a chip never
  // reads "Unknown", and a second Add of the same name finds the first
  const [added, setAdded] = useState<Person[]>([])
  const everyone = [...people, ...added.filter(a => !people.some(p => p.id === a.id))]

  const { name, exact, matches } = peopleSearch(query, everyone, peopleIds)
  // "+ Add" is offered exactly when Enter would add someone
  const pick = enterPick(query, everyone, peopleIds, !!onSavePerson)
  const canAddPerson = !!pick && 'add' in pick

  function attach(p: Person) {
    onChange(ids => (ids.includes(p.id) ? ids : [...ids, p.id]))
    setQuery('')
  }

  function addPerson() {
    if (!canAddPerson) return
    const p = newPerson(name, { id: uid(), color: randomColor(), now: new Date() })
    onSavePerson!(p)
    setAdded(a => [...a, p])
    attach(p)
  }

  if (people.length === 0 && !onSavePerson) return null
  return (
    <div className="field">
      <span>
        People <small>({hint})</small>
      </span>
      {/* only who is actually attached is listed; the rest are found by
          typing, so a long contact list never fills the editor */}
      {peopleIds.length > 0 && (
        <div className="platform-toggles attendees">
          {peopleIds.map(id => {
            const p = everyone.find(x => x.id === id)
            return (
              <button key={id} type="button" className="toggle on" onClick={() => onChange(ids => ids.filter(x => x !== id))} title="Remove">
                {p?.emoji ? `${p.emoji} ` : ''}
                {p?.name ?? 'Unknown'} ✕
              </button>
            )
          })}
        </div>
      )}
      <input
        className="people-picker-search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={peopleIds.length ? 'Add someone else…' : onSavePerson ? 'Search or add a person…' : 'Search people to add…'}
        onKeyDown={e => {
          if (e.key !== 'Enter' || !name) return
          e.preventDefault()
          if (!pick) return
          if ('add' in pick) addPerson()
          else attach(pick.attach)
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
          {exact && peopleIds.includes(exact.id) && matches.length === 0 && (
            <small className="muted">
              {exact.name} is already on this {noun}.
            </small>
          )}
          {!canAddPerson && !exact && matches.length === 0 && <small className="muted">No match.</small>}
        </div>
      )}
    </div>
  )
}
