import { useEffect, useMemo, useRef, useState } from 'react'
import { LookupError, type AddressCandidate } from '../geocode'
import { newerStamp } from '../itemops'
import { RHYTHM_CHIPS, countOf, personRhythmSuggestion, rhythmLabel, rhythmOf, seenTasks, visitDays, visitsFor, withRhythm, type Rhythm } from '../people'
import { filedAt, outingsAt, placeRhythmSuggestion, withAddress } from '../places'
import { daysWithin } from '../stats'
import { PLACE_CATEGORY_META, type CalendarEntry, type Meal, type Person, type Place, type Task } from '../types'
import { dateKey, fmtDate } from '../utils'
import { CandidateList, TownField, lookupMessage, useLookup, type Lookup } from './AddressFinder'
import { Modal, ModalHead } from './Modal'
import { Segmented } from './stats/Segmented'

// Who, and how often: every person and every place with its rhythm, set in
// one sitting. Most of the address book had none — thirty-odd people on the
// implicit 90 days and no place with any — and one at a time through each
// editor is not how anyone sets up thirty rows. A sheet over whatever you were
// on, never a tab.

export type RhythmSide = 'people' | 'places'

export const RHYTHM_SIDES: { key: RhythmSide; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'places', label: 'Places' },
]

/** One row saved: as it was, and as it goes back (Undo writes `before` again, stamped newer). */
export interface RhythmChange {
  before: Person | Place
  after: Person | Place
}

interface Props {
  people: Person[]
  places: Place[]
  tasks: Task[]
  /** Your own calendar entries: a past one with people on it counts as seeing them, as on People. */
  entries?: CalendarEntry[]
  /** A meal eaten out counts as going there, as on Places. */
  meals: Meal[]
  /** Whose visits the suggestions read: the address book is the household's, the log each member's own. */
  myId?: string | null
  /** The side it opens on. */
  side?: RhythmSide
  /** The rows whose rhythm changed, and only those. */
  onSave(changes: RhythmChange[]): void
  /** Find missing addresses saves each pick as it is made. */
  onSavePlace(p: Place): void
  onClose(): void
  now?: Date
  /** Tests hand in their own lookup; the sheet asks Drafter's server otherwise. */
  lookup?: Lookup
}

/** A row of either side, as the chips need it. */
export interface RhythmRow {
  id: string
  side: RhythmSide
  name: string
  mark: string
  color: string
  /** What is stored: days, No reminders, or none set. */
  current: Rhythm
  /** From your own visits, for a row with none set: pre-selected, and shown as a suggestion until tapped. */
  suggestion: number | null
  /** What the history says, in a few words. */
  line: string
  address?: string
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/** The words for a count of days in the last 90, or when it last was. */
function historyLine(days: string[], todayKey: string, words: { seen: string; last: string; never: string }): string {
  const recent = daysWithin(days, todayKey, 90)
  if (recent) return `${words.seen} ${countOf(recent, 'day')} in the last 90`
  return days[0] ? `${words.last} ${fmtDate(`${days[0]}T12:00`)}` : words.never
}

/** Every live person, A to Z, with what is stored and what your visits suggest. */
export function personRows(people: readonly Person[], tasks: Task[], entries: CalendarEntry[] | undefined, now: Date, myId?: string | null): RhythmRow[] {
  const todayKey = dateKey(now)
  const seen = seenTasks(tasks, entries, now, myId)
  return people
    .filter(p => !p.deletedAt)
    .map(p => {
      const current = rhythmOf(p)
      const days = visitDays(visitsFor(p.id, seen))
      return {
        id: p.id,
        side: 'people' as const,
        name: p.name,
        mark: p.emoji ?? p.name.slice(0, 1).toUpperCase(),
        color: p.color,
        current,
        suggestion: current === null ? personRhythmSuggestion(p, seen, todayKey) : null,
        line: historyLine(days, todayKey, { seen: 'Seen on', last: 'Last seen', never: 'No visits logged' }),
      }
    })
    .sort(byName)
}

/** Every live place, A to Z, likewise, with its address. */
export function placeRows(places: readonly Place[], tasks: Task[], meals: Meal[], now: Date, myId?: string | null): RhythmRow[] {
  const todayKey = dateKey(now)
  return places
    .filter(p => !p.deletedAt)
    .map(p => {
      const current = rhythmOf(p)
      const days = visitDays(outingsAt(p.id, tasks, meals, now, myId).map(v => ({ at: filedAt(v) })))
      return {
        id: p.id,
        side: 'places' as const,
        name: p.name,
        mark: p.emoji || PLACE_CATEGORY_META[p.category].emoji,
        color: p.color,
        current,
        suggestion: current === null ? placeRhythmSuggestion(p, tasks, meals, todayKey, now, myId) : null,
        line: historyLine(days, todayKey, { seen: 'Been on', last: 'Last went', never: 'No outings yet' }),
        address: p.address,
      }
    })
    .sort(byName)
}

/** What a row reads as now: a tap, else what is stored, else the suggestion. */
export const chosenFor = (row: RhythmRow, picks: Readonly<Record<string, Rhythm>>): Rhythm => (row.id in picks ? picks[row.id] : (row.current ?? row.suggestion))

/** The rows Save writes: those that would read differently from what is stored. */
export const changedRows = (rows: readonly RhythmRow[], picks: Readonly<Record<string, Rhythm>>): RhythmRow[] => rows.filter(r => chosenFor(r, picks) !== r.current)

/**
 * What Save will do, over both sides: the switch shows one side at a time, so
 * the line names each, and how many of them are suggestions still untapped.
 */
export function saveLine(changed: readonly RhythmRow[], suggested: number): string {
  if (!changed.length) return 'Nothing to save yet.'
  const people = changed.filter(r => r.side === 'people').length
  const places = changed.length - people
  const parts = [people && countOf(people, 'person', 'people'), places && countOf(places, 'place')].filter(Boolean)
  const which = suggested === changed.length ? (suggested === 1 ? 'It is a suggestion' : 'All are suggestions') : suggested === 1 ? 'One is a suggestion' : `${suggested} are suggestions`
  return `Save sets ${parts.join(' and ')}.${suggested ? ` ${which} from your own visits, dashed until you tap.` : ''}`
}

/** The chips a row offers: the six, and its own rhythm among them where it is one they do not name (60 days, say). */
export function chipsFor(current: Rhythm): { value: number | 'off'; label: string }[] {
  if (typeof current !== 'number' || RHYTHM_CHIPS.some(c => c.value === current)) return RHYTHM_CHIPS
  const own = { value: current, label: rhythmLabel(current) }
  const days = RHYTHM_CHIPS.filter(c => c.value !== 'off')
  const at = days.findIndex(c => (c.value as number) > current)
  const ordered = at === -1 ? [...days, own] : [...days.slice(0, at), own, ...days.slice(at)]
  return [...ordered, RHYTHM_CHIPS[RHYTHM_CHIPS.length - 1]]
}

function RhythmChips({ row, chosen, suggested, onPick }: { row: RhythmRow; chosen: Rhythm; suggested: boolean; onPick(v: number | 'off'): void }) {
  return (
    <div className="platform-toggles rhythm-chips" role="radiogroup" aria-label={`How often: ${row.name}`}>
      {chipsFor(row.current).map(c => {
        const on = chosen === c.value
        return (
          <button
            key={String(c.value)}
            type="button"
            role="radio"
            aria-checked={on}
            className={on ? (suggested ? 'toggle rhythm-chip suggested' : 'toggle rhythm-chip on') : 'toggle rhythm-chip'}
            title={on && suggested ? 'Suggested from your visits — tap to keep it' : undefined}
            onClick={() => onPick(c.value)}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Find missing addresses: the places with none, one at a time, each looked up
 * on OpenStreetMap (never two lookups closer than findAddress allows) and
 * offered to pick from or skip. A pick is saved at once, address and pin.
 */
export function MissingAddresses({ places, lookup, onSavePlace, onDone }: { places: Place[]; lookup?: Lookup; onSavePlace(p: Place): void; onDone(): void }) {
  const { area, typed, setTyped, canRun, run } = useLookup(places, lookup)
  // the places without an address as the run starts, in the list's order
  const [queue] = useState(() =>
    places
      .filter(p => !p.deletedAt && !p.address?.trim())
      .sort(byName)
      .map(p => p.id),
  )
  const [at, setAt] = useState(-1)
  const [state, setState] = useState<{ phase: 'start' | 'looking' | 'results' | 'error' | 'done'; found?: AddressCandidate[]; error?: string; fatal?: boolean }>({ phase: 'start' })
  const [tally, setTally] = useState({ saved: 0, skipped: 0 })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const latest = (id: string) => places.find(p => p.id === id)
  // one another device gave an address to (or deleted) since the run began is passed over
  const stillMissing = (id: string) => {
    const p = latest(id)
    return !!p && !p.deletedAt && !p.address?.trim()
  }

  // one lookup at a time: a second tap before the first has drawn is not a second skip
  const inFlight = useRef(false)
  const lookUp = async (from: number) => {
    if (inFlight.current) return
    let i = from
    while (i < queue.length && !stillMissing(queue[i])) i++
    setAt(i)
    if (i >= queue.length) {
      setState({ phase: 'done' })
      return
    }
    inFlight.current = true
    setState({ phase: 'looking' })
    try {
      const found = await run(latest(queue[i])!.name)
      if (alive.current) setState({ phase: 'results', found })
    } catch (e) {
      // no server, or not signed in: every other place would say the same
      const fatal = e instanceof LookupError && (e.kind === 'server' || e.kind === 'signin')
      if (alive.current) setState({ phase: 'error', error: lookupMessage(e), fatal })
    } finally {
      inFlight.current = false
    }
  }
  const next = (outcome: 'saved' | 'skipped') => {
    if (inFlight.current) return
    setTally(t => ({ ...t, [outcome]: t[outcome] + 1 }))
    void lookUp(at + 1)
  }

  const place = at >= 0 && at < queue.length ? latest(queue[at]) : undefined
  return (
    <section className="missing-addresses" aria-label="Find missing addresses">
      {state.phase === 'start' && (
        <>
          <p className="field-hint">
            {countOf(queue.length, 'place')} without an address. Each is looked up on OpenStreetMap by its name, {area ? area.label : 'near the town you give'}; pick the right one or skip it. A pick is saved at once, with a pin, so I&apos;m here finds the place next time.
          </p>
          {!area && <TownField value={typed} onChange={setTyped} />}
          <div className="missing-actions">
            <button type="button" className="btn primary" disabled={!canRun || !queue.length} onClick={() => void lookUp(0)}>
              Start
            </button>
            <button type="button" className="btn subtle" onClick={onDone}>
              Not now
            </button>
          </div>
        </>
      )}
      {place && state.phase !== 'start' && state.phase !== 'done' && (
        <>
          <p className="missing-progress">
            <span className="muted">
              {at + 1} of {queue.length}
            </span>{' '}
            <strong>{place.name}</strong>
          </p>
          {state.phase === 'looking' && <p className="field-hint">Looking it up…</p>}
          {state.phase === 'results' && state.found && state.found.length > 0 && (
            <CandidateList
              candidates={state.found}
              label={`Addresses for ${place.name}`}
              onPick={c => {
                if (inFlight.current) return
                const now = latest(place.id)
                if (now) onSavePlace({ ...withAddress(now, c), updatedAt: newerStamp(now.updatedAt) })
                next('saved')
              }}
            />
          )}
          {state.phase === 'results' && state.found?.length === 0 && <p className="field-hint">Nothing by that name {area ? area.label : 'there'}. Skip it, or add the address from the place&apos;s own Edit.</p>}
          {state.phase === 'error' && <p className="warn">{state.error}</p>}
          <div className="missing-actions">
            {state.phase === 'error' && !state.fatal && (
              <button type="button" className="btn" onClick={() => void lookUp(at)}>
                Try again
              </button>
            )}
            {!(state.phase === 'error' && state.fatal) && (
              <button type="button" className="btn" disabled={state.phase === 'looking'} onClick={() => next('skipped')}>
                Skip
              </button>
            )}
            <button type="button" className="btn subtle" onClick={onDone}>
              Stop
            </button>
          </div>
        </>
      )}
      {state.phase === 'done' && (
        <>
          <p className="field-hint">
            Done: {countOf(tally.saved, 'address', 'addresses')} saved, {tally.skipped} skipped.
          </p>
          <div className="missing-actions">
            <button type="button" className="btn" onClick={onDone}>
              Close
            </button>
          </div>
        </>
      )}
    </section>
  )
}

/**
 * "Who, and how often": a People · Places switch over every person and place,
 * each with the chips 1 week · 2 weeks · Monthly · 3 months · 6 months · No
 * reminders. What is stored is selected; a row with nothing stored has the
 * rhythm your own visits suggest pre-selected, drawn as a suggestion until you
 * tap. Save writes only the rows that changed, stamped newer, in one go.
 */
export function RhythmSheet({ people, places, tasks, entries, meals, myId = null, side: initialSide = 'people', onSave, onSavePlace, onClose, now: given, lookup }: Props) {
  const [now] = useState(() => given ?? new Date())
  const [side, setSide] = useState<RhythmSide>(initialSide)
  const [picks, setPicks] = useState<Record<string, Rhythm>>({})
  const [finding, setFinding] = useState(false)
  const people_ = useMemo(() => personRows(people, tasks, entries, now, myId), [people, tasks, entries, now, myId])
  const places_ = useMemo(() => placeRows(places, tasks, meals, now, myId), [places, tasks, meals, now, myId])
  const rows = side === 'people' ? people_ : places_
  const all = [...people_, ...places_]
  const changed = changedRows(all, picks)
  const suggested = changed.filter(r => !(r.id in picks)).length
  // your own taps, not the suggestions: what closing would throw away
  const tapped = changed.length - suggested
  const missing = places.filter(p => !p.deletedAt && !p.address?.trim()).length

  const close = () => {
    if (tapped > 0 && typeof window !== 'undefined' && !window.confirm(`Discard ${countOf(tapped, 'change')}?`)) return
    onClose()
  }
  const save = () => {
    const records = new Map<string, Person | Place>([...people, ...places].map(r => [r.id, r]))
    onSave(
      changed.flatMap(r => {
        const before = records.get(r.id)
        if (!before) return []
        return [{ before, after: { ...withRhythm(before, chosenFor(r, picks)), updatedAt: newerStamp(before.updatedAt) } }]
      }),
    )
  }

  return (
    <Modal onClose={close} className="modal narrow rhythm-sheet">
      <ModalHead title="Who, and how often" variant="compose">
        <button type="button" className="btn primary" disabled={!changed.length} onClick={save}>
          Save
        </button>
      </ModalHead>
      <div className="modal-body">
        <Segmented items={RHYTHM_SIDES} value={side} onChange={s => setSide(s)} label="People or places" className="rhythm-side" />
        <p className="field-hint">
          {side === 'people'
            ? 'Today, the morning digest and Plan next week ask after someone once their rhythm has gone by — about 3 months without one. No reminders keeps them out of all of it; birthdays still come up.'
            : 'A place only nudges you once it has a rhythm. No reminders also keeps it off Stats’ Not been back.'}
        </p>
        <p className="rhythm-summary" aria-live="polite">
          {saveLine(changed, suggested)}
        </p>

        {side === 'places' &&
          (finding ? (
            <MissingAddresses places={places} lookup={lookup} onSavePlace={onSavePlace} onDone={() => setFinding(false)} />
          ) : (
            missing > 0 && (
              <button type="button" className="btn find-missing" onClick={() => setFinding(true)}>
                Find missing addresses ({missing})
              </button>
            )
          ))}

        {rows.length === 0 ? (
          <p className="empty">{side === 'people' ? 'Nobody on the list yet.' : 'No places saved yet.'}</p>
        ) : (
          <ul className="rhythm-list">
            {rows.map(row => {
              const chosen = chosenFor(row, picks)
              const isSuggestion = !(row.id in picks) && row.current === null && row.suggestion !== null
              return (
                <li key={row.id} className="rhythm-row">
                  <div className="rhythm-who">
                    <span className="person-avatar small" style={{ background: row.color }} aria-hidden>
                      {row.mark}
                    </span>
                    <span className="rhythm-name">
                      <strong>{row.name}</strong>
                      <small className="muted">
                        {row.line}
                        {isSuggestion ? ` · suggested: ${rhythmLabel(row.suggestion).toLowerCase()}` : ''}
                        {row.current === null && !isSuggestion && !(row.id in picks) ? (side === 'people' ? ' · none set (about 3 months)' : ' · none set') : ''}
                      </small>
                      {side === 'places' && <small className="muted rhythm-address">{row.address ? `📍 ${row.address}` : 'No address'}</small>}
                    </span>
                  </div>
                  <RhythmChips row={row} chosen={chosen} suggested={isSuggestion} onPick={v => setPicks(p => ({ ...p, [row.id]: v }))} />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
