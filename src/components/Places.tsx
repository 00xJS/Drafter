import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useNow } from '../useNow'
import { useDayKey } from '../useDayKey'
import { timeOn } from '../useDayClock'
import { localDayKey } from '../journal'
import {
  Meal,
  CADENCE_META,
  Cadence,
  PLACE_CATEGORIES,
  PLACE_CATEGORY_META,
  PROJECT_COLORS,
  Person,
  Place,
  PlaceCategory,
  Task,
} from '../types'
import { newerStamp } from '../itemops'
import { isNative } from '../native'
import {
  PlaceFilter,
  PlaceStats,
  favourites,
  kindOn,
  lapsed,
  mapsUrl,
  placeAliasesFromText,
  placeMatcher,
  placeStats,
  placesWith,
  prefersAppleMaps,
  recentOutings,
  tidyPlaceAddress,
  withAddress,
} from '../places'
import { SEEN_META, cadenceChoice } from '../people'
import { OutingIdea, OutingInput, suggestOuting } from '../ai'
import { Bars } from './bits'
import { requestDevicePosition, tidyCoords } from '../geo'
import { FindAddress } from './AddressFinder'
import type { AddressCandidate } from '../geocode'
import { fmtDate, fromLocalInput, uid } from '../utils'
import { ConfirmButton } from './ConfirmButton'
import { Modal, ModalHead, useChanged } from './Modal'

interface Props {
  places: Place[]
  people: Person[]
  tasks: Task[]
  /** Meals eaten out here count as outings, so the rows need them too. */
  meals: Meal[]
  onSave(p: Place): void
  onDelete(id: string): void
  onLogOuting(place: Place, atIso: string, note: string, peopleIds: string[]): void
  onPlan(place: Place): void
  onOpenTask(t: Task): void
  /**
   * Whose outings this list reads. The places are the household's; going to
   * one is each member's own (v3.24). A meal shared with the household counts
   * for both, because that is the evening you both ate out.
   */
  myId?: string | null
  /** A row to expand on arrival (from search); consumed once. */
  openId?: string | null
  onOpenConsumed?(): void
  /** Open the add form from the List · Stats row; consumed once. */
  openAdd?: boolean
  onAddConsumed?(): void
  /** Turn an outing idea into a task. */
  onNewTask?(preset: Partial<Task>): void
  /** Places toolbar: open the I'm here sheet over the planner. */
  onImHere?(): void
  /**
   * The kind chip and find box. The shell holds them rather than the
   * list, so Places → Stats counts the rows they leave and List → Stats →
   * List keeps them.
   */
  filter: PlaceFilter
  onFilter(filter: PlaceFilter): void
}

type SortKey = 'attention' | 'recent' | 'most' | 'az' | 'za' | 'longest'

// Same wording as the People sort, with "been" instead of "seen".
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'az', label: 'A to Z' },
  { key: 'za', label: 'Z to A' },
  { key: 'recent', label: 'Most recently been' },
  { key: 'longest', label: 'Least recently been' },
  { key: 'most', label: 'Most visited' },
]

// Needs attention: overdue, due, never (a rhythm but no outing yet), then the rest by most recently been.
const ATTENTION_RANK: Record<PlaceStats['status'], number> = { overdue: 0, due: 1, never: 2, ok: 3, none: 3, off: 3 }

const byName = (a: PlaceStats, b: PlaceStats) => a.place.name.localeCompare(b.place.name)
/** When a row last went, '' for never: sorted as text, never first. */
const lastWent = (s: PlaceStats) => s.lastAt ?? ''

/**
 * Each sort's order, out here rather than in the list: written inline there,
 * one of them (a `??` feeding an `||` chain) is a shape the React Compiler
 * (1.0) does not handle yet, and it left the whole list as written for it.
 */
const PLACE_SORTS: Record<SortKey, (a: PlaceStats, b: PlaceStats) => number> = {
  attention: (a, b) => ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status] || lastWent(b).localeCompare(lastWent(a)) || byName(a, b),
  az: byName,
  za: (a, b) => byName(b, a),
  most: (a, b) => b.visits.length - a.visits.length,
  longest: (a, b) => lastWent(a).localeCompare(lastWent(b)) || byName(a, b),
  recent: (a, b) => lastWent(b).localeCompare(lastWent(a)) || byName(a, b),
}

export function PlaceForm({
  place,
  places = [],
  onSave,
  onDelete,
  onClose,
}: {
  place?: Place
  /** Every place: Find address leans its lookup to the middle of the pinned ones. */
  places?: Place[]
  onSave(p: Place): void
  onDelete?(id: string): void
  onClose(): void
}) {
  const [name, setName] = useState(place?.name ?? '')
  const [emoji, setEmoji] = useState(place?.emoji ?? '')
  // a new place starts with no kind: Save waits for one, as it does wherever a place is made
  const [category, setCategory] = useState<PlaceCategory | undefined>(place?.category)
  const [color, setColor] = useState(() => place?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)])
  // No target by default: a place only nags when you ask it to. 'off' is No reminders.
  const [cadence, setCadence] = useState<Cadence | '' | 'off'>(place?.noReminders ? 'off' : ((place?.cadenceDays as Cadence | undefined) ?? ''))
  const [notes, setNotes] = useState(place?.notes ?? '')
  const [address, setAddress] = useState(place?.address ?? '')
  // one box, the names separated by commas: a name rarely holds a comma, an address often does
  const [aliases, setAliases] = useState((place?.aliases ?? []).join(', '))
  const [pin, setPin] = useState(() => tidyCoords(place ?? {}))
  const [pinning, setPinning] = useState(false)
  const dirty = useChanged({ name, emoji, category, color, cadence, notes, address, aliases, pin })
  const save = () => {
    if (!name.trim() || !category) return
    const now = new Date().toISOString()
    onSave({
      kind: 'place',
      id: place?.id ?? uid(),
      name: name.trim(),
      emoji: emoji.trim() || undefined,
      category,
      color,
      cadenceDays: cadence === '' || cadence === 'off' ? undefined : cadence,
      noReminders: cadence === 'off' || undefined,
      notes: notes.trim() || undefined,
      address: tidyPlaceAddress(address),
      aliases: placeAliasesFromText(aliases, name.trim()),
      ...(pin ? { lat: pin.lat, lon: pin.lon } : {}),
      createdAt: place?.createdAt ?? now,
      updatedAt: place ? newerStamp(place.updatedAt) : now,
    })
    onClose()
  }
  const pinHere = async () => {
    setPinning(true)
    const here = await requestDevicePosition()
    setPinning(false)
    if (here) setPin(here)
  }
  return (
    <Modal onClose={onClose} dirty={dirty} className="modal narrow">
      <ModalHead title={place ? `Edit ${place.name}` : 'Add a place'} variant="compose">
        <button type="button" className="btn primary" disabled={!name.trim() || !category} onClick={save}>
          Save
        </button>
      </ModalHead>
      <div className="modal-body">
        <div className="field-row">
          <label className="field emoji-field">
            <span>Icon</span>
            <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="🍽️" maxLength={4} />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Franco's" autoFocus />
          </label>
        </div>
        <div className="field">
          <span>Category</span>
          <div className="segmented" style={{ flexWrap: 'wrap' }}>
            {PLACE_CATEGORIES.map(c => (
              <button key={c} type="button" className={category === c ? 'seg on' : 'seg'} onClick={() => setCategory(c)}>
                {PLACE_CATEGORY_META[c].emoji} {PLACE_CATEGORY_META[c].label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>
            Address <small>(optional)</small>
          </span>
          {/* autofill would offer your own address, which is not this place's */}
          <input value={address} onChange={e => setAddress(e.target.value)} placeholder="e.g. 21 Warwick St, London" autoComplete="off" />
          <div className="check-add" style={{ marginTop: 8 }}>
            <button type="button" className="btn" disabled={pinning} onClick={() => void pinHere()}>
              {pinning ? 'Finding you…' : pin ? 'Update pin' : 'Pin this spot'}
            </button>
            {pin && (
              <button type="button" className="btn subtle" onClick={() => setPin(undefined)}>
                Clear pin
              </button>
            )}
          </div>
          {pin && <small className="field-hint">Pinned so I&apos;m here can find this place next time.</small>}
        </label>
        {/* the name (and the address as far as it is typed) looked up on
            OpenStreetMap: a pick fills the address and the pin, for Save */}
        <FindAddress
          name={name}
          address={address}
          places={places}
          onPick={c => {
            setAddress(c.address)
            setPin(tidyCoords(c))
          }}
        />
        <label className="field">
          <span>
            Other names <small>(optional, separated by commas)</small>
          </span>
          <input value={aliases} onChange={e => setAliases(e.target.value)} placeholder="e.g. Franco's Pizzeria, Francos" autoComplete="off" />
          <small className="field-hint">A calendar event at any of these names, or at the address, is marked as here.</small>
        </label>
        <label className="field">
          <span>
            How often do you want to go back? <small>(only then does it nudge)</small>
          </span>
          <select value={cadence} onChange={e => setCadence(cadenceChoice(e.target.value))}>
            <option value="">No target — just track it</option>
            {(Object.keys(CADENCE_META).map(Number) as Cadence[]).map(c => (
              <option key={c} value={c}>
                {CADENCE_META[c]}
              </option>
            ))}
            <option value="off">No reminders — not in Stats' lists either</option>
          </select>
        </label>
        <div className="field">
          <span>Color</span>
          <div className="swatches">
            {PROJECT_COLORS.map(c => (
              <button key={c} type="button" className={color === c ? 'swatch on' : 'swatch'} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
        </div>
        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Best table, booking tip, what to order…" />
        </label>
      </div>
      {place && onDelete && (
        <footer className="modal-foot">
          <ConfirmButton
            className="btn subtle danger"
            confirmLabel="Tap again to remove"
            onConfirm={() => {
              onDelete(place.id)
              onClose()
            }}
          >
            Remove
          </ConfirmButton>
        </footer>
      )}
    </Modal>
  )
}

export function LogOuting({
  place,
  people,
  onLog,
  onClose,
}: {
  place: Place
  people: Person[]
  onLog(atIso: string, note: string, peopleIds: string[]): void
  onClose(): void
}) {
  // today, read once as the sheet opens, as Saw them does on People
  const [date, setDate] = useState(() => localDayKey())
  const [note, setNote] = useState('')
  const [ids, setIds] = useState<string[]>([])
  const dirty = useChanged({ date, note, ids })
  const log = () => {
    onLog(fromLocalInput(`${date}T12:00`)!, note.trim(), ids)
    onClose()
  }
  return (
    <Modal onClose={onClose} dirty={dirty} className="modal narrow">
      <ModalHead title={`Went to ${place.name}`} variant="compose">
        <button type="button" className="btn primary" disabled={!date} onClick={log}>
          Log it
        </button>
      </ModalHead>
      <div className="modal-body">
        <label className="field">
          <span>When</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>What did you do?</span>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Dinner, coffee, walk…" autoFocus />
        </label>
        {people.length > 0 && (
          <div className="field">
            <span>Who was there?</span>
            <div className="platform-toggles">
              {people.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={ids.includes(p.id) ? 'toggle on' : 'toggle'}
                  onClick={() => setIds(cur => (cur.includes(p.id) ? cur.filter(x => x !== p.id) : [...cur, p.id]))}
                >
                  {p.emoji ? `${p.emoji} ` : ''}
                  {p.name}
                </button>
              ))}
            </div>
            <small className="field-hint">Solo visits are fine — leave everyone unticked.</small>
          </div>
        )}
      </div>
    </Modal>
  )
}

export function PlaceRow({
  stats,
  open,
  onToggle,
  onEdit,
  onLog,
  onPlan,
  onOpenTask,
  places,
  onSaveAddress,
}: {
  stats: PlaceStats
  open: boolean
  onToggle(): void
  onEdit(): void
  onLog(): void
  onPlan(): void
  onOpenTask(t: Task): void
  /** Every place, for Find address to lean its lookup to. */
  places?: Place[]
  /** Save an address found for a place that has none (Find address on its card). Without it the card offers none. */
  onSaveAddress?(found: AddressCandidate): void
}) {
  const { place } = stats
  const now = useNow()
  const cat = PLACE_CATEGORY_META[place.category]
  // the iPhone app is an Apple device whatever its web view says
  const apple = isNative() || prefersAppleMaps()
  // Only a place with a rhythm gets a badge; the rest are just tracked, and
  // one on No reminders is as quiet as one with none
  const meta = stats.status === 'none' || stats.status === 'off' ? null : SEEN_META[stats.status]
  return (
    <li id={`place-${place.id}`} className={open ? 'person-row open' : 'person-row'}>
      <button className="person-summary" onClick={onToggle} aria-expanded={open}>
        <span className="person-avatar" style={{ background: place.color }}>
          {place.emoji ?? cat.emoji}
        </span>
        <span className="person-ident">
          <strong>{place.name}</strong>
          <small className="muted">{stats.reason}</small>
        </span>
        <span className="person-inline-stats">
          <span title="Outings in the last 12 months">
            <strong>{stats.count365}</strong>
            <small>12mo</small>
          </span>
          <span title="Outings in the last 90 days">
            <strong>{stats.visits.filter(v => now - Date.parse(v.at) < 90 * 86_400_000).length}</strong>
            <small>90d</small>
          </span>
        </span>
        {meta && (
          <span className="badge" style={{ background: meta.bg, color: meta.color }}>
            {meta.label}
          </span>
        )}
        <span className="person-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="person-detail">
          {(!!place.address || !!place.aliases?.length) && (
            <div className="place-where">
              {place.address && <span>📍 {place.address}</span>}
              {!!place.aliases?.length && <small className="muted">Also called {place.aliases.join(', ')}</small>}
            </div>
          )}
          {/* no address yet: look it up where the place is shown, and a pick is saved with its pin */}
          {!place.address && onSaveAddress && <FindAddress name={place.name} address="" places={places ?? []} onPick={onSaveAddress} saves />}
          <div className="person-stats">
            <Bars weekly={stats.weekly} color={place.color} />
            <span className="person-nums">
              <span>
                <strong>{stats.avgGapDays ? Math.round(stats.avgGapDays) : '—'}</strong>
                <small>avg gap</small>
              </span>
              <span>
                <strong>{stats.visits.length}</strong>
                <small>all time</small>
              </span>
              <span>
                <strong>{stats.visits.length ? fmtDate(stats.visits[stats.visits.length - 1].at) : '—'}</strong>
                <small>first went</small>
              </span>
            </span>
          </div>

          {stats.visits.length > 0 && (
            <ul className="person-recent">
              {stats.visits.slice(0, 4).map(v =>
                v.kind === 'task' ? (
                  <li key={v.task.id} onClick={() => onOpenTask(v.task)}>
                    <button type="button" className="row-open">
                      <span>{v.task.title || 'Outing'}</span>
                    </button>
                    <small className="muted">{fmtDate(v.at)}</small>
                  </li>
                ) : (
                  // a takeaway has no task behind it, so this row does not open
                  <li key={v.meal.id} className="outing-meal">
                    <span>🥡 {v.meal.title || 'Ate out'}</span>
                    <small className="muted">{fmtDate(v.at)}</small>
                  </li>
                ),
              )}
            </ul>
          )}

          {stats.companions.length > 0 && (
            <div className="field">
              <span className="muted">Usually with</span>
              <div className="platform-toggles attendees">
                {stats.companions.map(c => (
                  <span key={c.person.id} className="toggle on" style={{ cursor: 'default' }}>
                    {c.person.emoji ? `${c.person.emoji} ` : ''}
                    {c.person.name}
                    <small className="muted"> ×{c.count}</small>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="person-actions">
            <button className="btn" onClick={onLog}>
              Went there
            </button>
            <button className="btn" onClick={onPlan}>
              Plan a trip
            </button>
            {/* a link, as the app's other outside links are: a new tab on the web,
                and in the iPhone app the system takes it, so Maps opens */}
            <a className="btn" href={mapsUrl(place, apple)} target="_blank" rel="noreferrer">
              Open in Maps
            </a>
            <button className="btn subtle" onClick={onEdit}>
              Edit
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/**
 * What "Where should we go?" sends: your favourites, the places you drifted
 * from, the newest outings of any kind (a meal eaten out is one, as it is on
 * every row), and for whoever is coming, where you have been together.
 */
export function outingIdeasInput(o: { places: Place[]; people: Person[]; tasks: Task[]; meals: Meal[]; withIds: string[]; now?: Date }): OutingInput {
  const now = o.now ?? new Date()
  const row = (s: PlaceStats) => ({
    name: s.place.name,
    category: PLACE_CATEGORY_META[s.place.category].label,
    times: s.visits.length,
    lastWent: s.lastAt ? fmtDate(s.lastAt) : 'never',
  })
  const stats = o.places.map(p => placeStats(p, o.tasks, o.people, now, o.meals))
  return {
    weekday: now.toLocaleDateString(undefined, { weekday: 'long' }),
    favourites: favourites(o.places, o.tasks, o.people, now, o.meals).slice(0, 6).map(row),
    lapsed: lapsed(o.places, o.tasks, o.people, now, o.meals).slice(0, 6).map(row),
    recent: recentOutings(stats).map(r => ({ name: r.place.name, when: fmtDate(r.outing.at) })),
    allNames: o.places.map(p => p.name),
    // names and shared places only: a person's notes never go out
    with: o.withIds.flatMap(id => {
      const person = o.people.find(p => p.id === id)
      if (!person) return []
      const together = placesWith(id, o.places, o.tasks).slice(0, 5)
      return [{ name: person.name, group: person.group, places: together.map(r => ({ name: r.place.name, category: PLACE_CATEGORY_META[r.place.category].label, times: r.count, lastWent: fmtDate(r.lastAt) })) }]
    }),
  }
}

/** A tapped idea as a task: at its place when it named one of yours, and with whoever is coming. */
export function outingIdeaTask(idea: OutingIdea, place: Place | undefined, peopleIds: string[]): Partial<Task> {
  return { title: idea.title, status: 'todo', placeId: place?.id, tags: ['visit'], ...(peopleIds.length ? { peopleIds } : {}) }
}

/** "Mum", "Mum and Sam", "Mum, Sam and Jo". */
const namesOf = (ps: Person[]) => (ps.length < 2 ? (ps[0]?.name ?? '') : `${ps.slice(0, -1).map(p => p.name).join(', ')} and ${ps[ps.length - 1].name}`)

export function Places({ places, people, tasks, myId, onSave, onDelete, onLogOuting, onPlan, onOpenTask, openId: wantOpen, onOpenConsumed, openAdd, onAddConsumed, onNewTask, onImHere, meals, filter, onFilter }: Props) {
  const [editing, setEditing] = useState<{ place?: Place } | null>(() => (openAdd ? {} : null))
  const [logging, setLogging] = useState<Place | null>(null)
  // the kind chip that is on: once a kind's last place has gone, All, as on Stats
  const category = kindOn(places, filter.category)
  // "Needs attention" only earns the default once at least one place has a rhythm.
  const [sortChoice, setSortChoice] = useState<SortKey | null>(null)
  const sort: SortKey = sortChoice ?? (places.some(p => p.cadenceDays) ? 'attention' : 'recent')
  // a row asked for opens with the first paint when Places mounts for it
  const [openId, setOpenId] = useState<string | null>(() => wantOpen ?? null)
  /** The whole list folded away, as on People. Not remembered. */
  const [listShut, setListShut] = useState(false)
  const [ideas, setIdeas] = useState<OutingIdea[] | null>(null)
  const [ideasBusy, setIdeasBusy] = useState(false)
  const [ideasError, setIdeasError] = useState('')
  // who is coming, if you say: the ideas draw on where you go together, and
  // the task a tapped idea makes has them on it
  const [withIds, setWithIds] = useState<string[]>([])
  const [askedWith, setAskedWith] = useState<string[] | null>(null)
  const [withAll, setWithAll] = useState(false)

  // A row or the add sheet asked for while this is already on screen opens
  // as the ask arrives. The People tab clears the find box and the chip as
  // the row is asked for, so neither hides it.
  const [asked, setAsked] = useState({ wantOpen, openAdd })
  if (asked.wantOpen !== wantOpen || asked.openAdd !== openAdd) {
    setAsked({ wantOpen, openAdd })
    if (wantOpen && wantOpen !== asked.wantOpen) setOpenId(wantOpen)
    if (openAdd && !asked.openAdd) setEditing({})
  }
  // Once per ask, as on People: a new setter alone is no new ask
  const openConsumed = useEffectEvent(() => onOpenConsumed?.())
  const addConsumed = useEffectEvent(() => onAddConsumed?.())
  useEffect(() => {
    if (!wantOpen) return
    // a long list can hold the row below the fold; one already in view stays put
    window.setTimeout(() => document.getElementById(`place-${wantOpen}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60)
    openConsumed()
  }, [wantOpen])
  useEffect(() => {
    if (openAdd) addConsumed()
  }, [openAdd])

  // counted at the time what they count changes, and again when the day does
  const today = useDayKey()
  const allStats = useMemo(() => {
    const now = timeOn(today)
    return places.map(p => placeStats(p, tasks, people, now, meals, myId))
  }, [places, tasks, people, meals, myId, today])

  // who you go out with most, first: the With row offers them, "+ Who" everyone
  const company = useMemo(
    () =>
      people
        .map(person => ({ person, outings: placesWith(person.id, places, tasks).reduce((n, r) => n + r.count, 0) }))
        .sort((a, b) => b.outings - a.outings || a.person.name.localeCompare(b.person.name)),
    [people, places, tasks],
  )
  const usual = new Set(company.filter(c => c.outings > 0).slice(0, 6).map(c => c.person.id))
  const withShown = withAll ? company : company.filter(c => usual.has(c.person.id) || withIds.includes(c.person.id))
  const withPeople = people.filter(p => withIds.includes(p.id))
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id))
  // the ideas on screen were asked for someone else, or not at all
  const askAgain = !!ideasError || (askedWith !== null && !sameIds(askedWith, withPeople.map(p => p.id)))

  // a chain rather than try/catch/finally, which the React Compiler cannot
  // compile; the question is put together inside it, so a failure there is
  // said too, and the button is freed whatever happened
  const getIdeas = () => {
    const asked = withPeople.map(p => p.id)
    setIdeasBusy(true)
    setIdeasError('')
    setAskedWith(asked)
    void Promise.resolve()
      .then(() => suggestOuting(outingIdeasInput({ places, people, tasks, meals, withIds: asked })))
      .then(setIdeas, (e: Error) => setIdeasError(e.message))
      .then(() => setIdeasBusy(false))
  }

  const shown = useMemo(() => {
    // Places → Stats counts by this same rule, so its figures and these rows agree
    const matches = placeMatcher(places, filter)
    return allStats.filter(s => matches(s.place)).sort(PLACE_SORTS[sort])
  }, [allStats, places, filter, sort])

  // The tiles and the year in places moved to Places → Stats (PlacesStats),
  // which counts from these same rows, so the list keeps to the places.
  return (
    <section className="people">
      <div className="toolbar people-toolbar">
        <div>
          <h2 className="view-title">Places</h2>
          <p className="chart-sub">Where you've been, how often, and who you usually go with.</p>
        </div>
        <span className="spacer" />
        {places.length > 0 && (
          <button className="btn" disabled={ideasBusy} onClick={getIdeas} title="Ideas drawn from your own places">
            {ideasBusy ? 'Thinking…' : '✨ Where should we go?'}
          </button>
        )}
        {onImHere && (
          <button className="btn" onClick={onImHere} title="Log where you are, and who you are with">
            I&apos;m here
          </button>
        )}
      </div>

      {(ideas || ideasError) && (
        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Where should we go?</h3>
              <p className="chart-sub">
                From your favourites and the places you've drifted from — tap one to plan it{withPeople.length ? ` with ${namesOf(withPeople)}` : ''}
              </p>
            </div>
            <button
              className="btn subtle"
              onClick={() => {
                setIdeas(null)
                setIdeasError('')
              }}
              aria-label="Dismiss ideas"
            >
              ✕
            </button>
          </header>
          {people.length > 0 && (
            <div className="field outing-with">
              <span className="muted">With</span>
              <div className="platform-toggles">
                {withShown.map(({ person: p }) => (
                  <button
                    key={p.id}
                    type="button"
                    className={withIds.includes(p.id) ? 'toggle on' : 'toggle'}
                    aria-pressed={withIds.includes(p.id)}
                    onClick={() => setWithIds(ids => (ids.includes(p.id) ? ids.filter(x => x !== p.id) : [...ids, p.id]))}
                  >
                    {p.emoji ? `${p.emoji} ` : ''}
                    {p.name}
                  </button>
                ))}
                {(withAll || withShown.length < company.length) && (
                  <button type="button" className="btn subtle" onClick={() => setWithAll(v => !v)} aria-expanded={withAll}>
                    {withAll ? 'Hide' : '+ Who'}
                  </button>
                )}
                {askAgain && (
                  <button type="button" className="btn" disabled={ideasBusy} onClick={getIdeas}>
                    {ideasBusy ? 'Thinking…' : '✨ Ask again'}
                  </button>
                )}
              </div>
            </div>
          )}
          {ideasError ? (
            <p className="warn">{ideasError}</p>
          ) : (
            <ul className="person-ideas">
              {ideas!.map((i, idx) => {
                const target = i.placeName ? places.find(p => p.name === i.placeName) : undefined
                return (
                  <li key={`${idx}:${i.title}`}>
                    <button
                      type="button"
                      className="person-idea"
                      title="Turn into a task"
                      onClick={() => onNewTask?.(outingIdeaTask(i, target, withPeople.map(p => p.id)))}
                    >
                      <strong>
                        {target ? `${target.emoji ?? PLACE_CATEGORY_META[target.category].emoji} ` : ''}
                        {i.title}
                      </strong>
                      <small>{i.why}</small>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {places.length === 0 ? (
        <div className="chart-card">
          <p className="empty">
            Add the places you go — restaurants, parks, venues. Log an outing or attach a place on a task; when it's done, it
            counts here.
          </p>
        </div>
      ) : (
        <>
          <div className="people-controls">
            <span className="segmented kind-chips">
              <button className={category === 'all' ? 'seg on' : 'seg'} onClick={() => onFilter({ ...filter, category: 'all' })}>
                All <span className="board-count">{allStats.length}</span>
              </button>
              {PLACE_CATEGORIES.map(c => {
                const n = allStats.filter(s => s.place.category === c).length
                if (n === 0) return null
                return (
                  <button key={c} className={category === c ? 'seg on' : 'seg'} onClick={() => onFilter({ ...filter, category: c })}>
                    {PLACE_CATEGORY_META[c].label} <span className="board-count">{n}</span>
                  </button>
                )
              })}
            </span>
            <input className="search people-search" placeholder="Find a place…" value={filter.q} onChange={e => onFilter({ ...filter, q: e.target.value })} />
            <label className="people-sort">
              Sort
              <select value={sort} onChange={e => setSortChoice(e.target.value as SortKey)}>
                {SORTS.map(s => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="spacer" />
            {/* as on People: Collapse shuts the open row and is only there when
                one is, and Hide list folds the whole list. Neither is ever a
                greyed-out button that reads as broken. */}
            {openId && (
              <button className="btn" onClick={() => setOpenId(null)}>
                Collapse card
              </button>
            )}
            <button className="btn" aria-expanded={!listShut} onClick={() => setListShut(v => !v)}>
              {listShut ? `Show ${shown.length} place${shown.length === 1 ? '' : 's'}` : 'Hide list'}
            </button>
          </div>

          {listShut ? (
            <p className="empty">
              {shown.length} place{shown.length === 1 ? '' : 's'} hidden.{' '}
              <button type="button" className="btn subtle" onClick={() => setListShut(false)}>
                Show them
              </button>
            </p>
          ) : shown.length === 0 ? (
            <p className="empty">Nothing matches.</p>
          ) : (
            <ul className="people-list">
              {shown.map(s => (
                <PlaceRow
                  key={s.place.id}
                  stats={s}
                  open={openId === s.place.id}
                  onToggle={() => setOpenId(cur => (cur === s.place.id ? null : s.place.id))}
                  onEdit={() => setEditing({ place: s.place })}
                  onLog={() => setLogging(s.place)}
                  onPlan={() => onPlan(s.place)}
                  onOpenTask={onOpenTask}
                  places={places}
                  onSaveAddress={found => {
                    // the place as it is now, not as the row was drawn
                    const now = places.find(p => p.id === s.place.id) ?? s.place
                    onSave({ ...withAddress(now, found), updatedAt: newerStamp(now.updatedAt) })
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {editing && <PlaceForm place={editing.place} places={places} onSave={onSave} onDelete={onDelete} onClose={() => setEditing(null)} />}
      {logging && (
        <LogOuting
          place={logging}
          people={people}
          onLog={(at, note, peopleIds) => onLogOuting(logging, at, note, peopleIds)}
          onClose={() => setLogging(null)}
        />
      )}
    </section>
  )
}
