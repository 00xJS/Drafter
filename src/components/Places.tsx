import { useEffect, useMemo, useState } from 'react'
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
import { PlaceStats, favourites, lapsed, placeStats, placeYearReport, placesWith, recentOutings } from '../places'
import { SEEN_META, countOf } from '../people'
import { OutingIdea, OutingInput, suggestOuting } from '../ai'
import { heatStyle } from '../contrast'
import { useTheme } from '../theme'
import { Bars, TrendBadge } from './People'
import { fmtDate, fromLocalInput, uid } from '../utils'
import { ConfirmButton } from './ConfirmButton'
import { Modal, ModalHead } from './Modal'

interface Props {
  places: Place[]
  people: Person[]
  tasks: Task[]
  /** Meals eaten out here count as outings, so the stats need them too. */
  meals: Meal[]
  onSave(p: Place): void
  onDelete(id: string): void
  onLogOuting(place: Place, atIso: string, note: string, peopleIds: string[]): void
  onPlan(place: Place): void
  onOpenTask(t: Task): void
  /** A row to expand on arrival (from search); consumed once. */
  openId?: string | null
  onOpenConsumed?(): void
  /** Turn an outing idea into a task. */
  onNewTask?(preset: Partial<Task>): void
}

type CategoryFilter = 'all' | PlaceCategory
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
const ATTENTION_RANK: Record<PlaceStats['status'], number> = { overdue: 0, due: 1, never: 2, ok: 3, none: 3 }

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

function PlaceForm({
  place,
  onSave,
  onDelete,
  onClose,
}: {
  place?: Place
  onSave(p: Place): void
  onDelete?(id: string): void
  onClose(): void
}) {
  const [name, setName] = useState(place?.name ?? '')
  const [emoji, setEmoji] = useState(place?.emoji ?? '')
  // a new place starts with no kind: Save waits for one, as it does wherever a place is made
  const [category, setCategory] = useState<PlaceCategory | undefined>(place?.category)
  const [color, setColor] = useState(place?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)])
  // No target by default: a place only nags when you ask it to.
  const [cadence, setCadence] = useState<Cadence | ''>((place?.cadenceDays as Cadence | undefined) ?? '')
  const [notes, setNotes] = useState(place?.notes ?? '')
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
      cadenceDays: cadence === '' ? undefined : cadence,
      notes: notes.trim() || undefined,
      createdAt: place?.createdAt ?? now,
      updatedAt: place ? newerStamp(place.updatedAt) : now,
    })
    onClose()
  }
  return (
    <Modal onClose={onClose} className="modal narrow">
      <ModalHead title={place ? `Edit ${place.name}` : 'Add a place'} />
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
            How often do you want to go back? <small>(only then does it nudge)</small>
          </span>
          <select value={cadence} onChange={e => setCadence(e.target.value === '' ? '' : (Number(e.target.value) as Cadence))}>
            <option value="">No target — just track it</option>
            {(Object.keys(CADENCE_META).map(Number) as Cadence[]).map(c => (
              <option key={c} value={c}>
                {CADENCE_META[c]}
              </option>
            ))}
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
      <footer className="modal-foot">
        {place && onDelete && (
          <ConfirmButton
            className="btn subtle danger"
            confirmLabel="Click again to remove"
            onConfirm={() => {
              onDelete(place.id)
              onClose()
            }}
          >
            Remove
          </ConfirmButton>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!name.trim() || !category} onClick={save}>
          Save
        </button>
      </footer>
    </Modal>
  )
}

function LogOuting({
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
  const today = new Date()
  const [date, setDate] = useState(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
  )
  const [note, setNote] = useState('')
  const [ids, setIds] = useState<string[]>([])
  return (
    <Modal onClose={onClose} className="modal narrow">
      <ModalHead title={`Went to ${place.name}`} />
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
      <footer className="modal-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!date}
          onClick={() => {
            onLog(fromLocalInput(`${date}T12:00`)!, note.trim(), ids)
            onClose()
          }}
        >
          Log it
        </button>
      </footer>
    </Modal>
  )
}

function PlaceRow({
  stats,
  open,
  onToggle,
  onEdit,
  onLog,
  onPlan,
  onOpenTask,
}: {
  stats: PlaceStats
  open: boolean
  onToggle(): void
  onEdit(): void
  onLog(): void
  onPlan(): void
  onOpenTask(t: Task): void
}) {
  const { place } = stats
  const cat = PLACE_CATEGORY_META[place.category]
  // Only a place with a rhythm gets a badge; the rest are just tracked.
  const meta = stats.status === 'none' ? null : SEEN_META[stats.status]
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
            <strong>{stats.visits.filter(v => Date.now() - Date.parse(v.at) < 90 * 86_400_000).length}</strong>
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

export function Places({ places, people, tasks, onSave, onDelete, onLogOuting, onPlan, onOpenTask, openId: wantOpen, onOpenConsumed, onNewTask, meals }: Props) {
  const [editing, setEditing] = useState<{ place?: Place } | null>(null)
  const [logging, setLogging] = useState<Place | null>(null)
  const [category, setCategory] = useState<CategoryFilter>('all')
  // "Needs attention" only earns the default once at least one place has a rhythm.
  const [sortChoice, setSortChoice] = useState<SortKey | null>(null)
  const sort: SortKey = sortChoice ?? (places.some(p => p.cadenceDays) ? 'attention' : 'recent')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [ideas, setIdeas] = useState<OutingIdea[] | null>(null)
  const [ideasBusy, setIdeasBusy] = useState(false)
  const [ideasError, setIdeasError] = useState('')
  const [year, setYear] = useState(() => new Date().getFullYear())
  // the year table's cells choose their ink for the theme on screen
  const theme = useTheme()
  // who is coming, if you say: the ideas draw on where you go together, and
  // the task a tapped idea makes has them on it
  const [withIds, setWithIds] = useState<string[]>([])
  const [askedWith, setAskedWith] = useState<string[] | null>(null)
  const [withAll, setWithAll] = useState(false)

  useEffect(() => {
    if (!wantOpen) return
    setOpenId(wantOpen)
    setQ('')
    setCategory('all')
    // a long list can hold the row below the fold; one already in view stays put
    window.setTimeout(() => document.getElementById(`place-${wantOpen}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60)
    onOpenConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantOpen])

  const allStats = useMemo(() => places.map(p => placeStats(p, tasks, people, new Date(), meals)), [places, tasks, people, meals])

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

  const getIdeas = async () => {
    const asked = withPeople.map(p => p.id)
    setIdeasBusy(true)
    setIdeasError('')
    setAskedWith(asked)
    try {
      setIdeas(await suggestOuting(outingIdeasInput({ places, people, tasks, meals, withIds: asked })))
    } catch (e) {
      setIdeasError((e as Error).message)
    } finally {
      setIdeasBusy(false)
    }
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = allStats
      .filter(s => category === 'all' || s.place.category === category)
      .filter(s => !needle || s.place.name.toLowerCase().includes(needle) || (s.place.notes ?? '').toLowerCase().includes(needle))
    const sorted = [...list]
    if (sort === 'attention')
      sorted.sort(
        (a, b) =>
          ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status] ||
          (b.lastAt ?? '').localeCompare(a.lastAt ?? '') ||
          a.place.name.localeCompare(b.place.name),
      )
    else if (sort === 'az') sorted.sort((a, b) => a.place.name.localeCompare(b.place.name))
    else if (sort === 'za') sorted.sort((a, b) => b.place.name.localeCompare(a.place.name))
    else if (sort === 'most') sorted.sort((a, b) => b.visits.length - a.visits.length)
    else if (sort === 'longest')
      sorted.sort((a, b) => (a.lastAt ?? '').localeCompare(b.lastAt ?? '') || a.place.name.localeCompare(b.place.name))
    else sorted.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.place.name.localeCompare(b.place.name))
    return sorted
  }, [allStats, category, sort, q])

  const beenAWhile = useMemo(() => shown.filter(s => s.status === 'due' || s.status === 'overdue').length, [shown])

  const shownPlaces = useMemo(() => shown.map(s => s.place), [shown])

  // The calendar year, summed from the year table's own count (a meal on its
  // own date), so the tile and this year's table cannot disagree. The rows
  // above count the last 12 months instead, as their "12mo" says.
  const thisYear = new Date().getFullYear()
  const outingsThisYear = useMemo(
    () => placeYearReport(shownPlaces, tasks, meals, thisYear).reduce((n, r) => n + r.total, 0),
    [shownPlaces, tasks, meals, thisYear],
  )

  const report = useMemo(() => placeYearReport(shownPlaces, tasks, meals, year), [shownPlaces, tasks, meals, year])

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
        <button className="btn primary" onClick={() => setEditing({})}>
          + Add place
        </button>
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
            <span className="segmented" style={{ flexWrap: 'wrap' }}>
              <button className={category === 'all' ? 'seg on' : 'seg'} onClick={() => setCategory('all')}>
                All <span className="board-count">{allStats.length}</span>
              </button>
              {PLACE_CATEGORIES.map(c => {
                const n = allStats.filter(s => s.place.category === c).length
                if (n === 0) return null
                return (
                  <button key={c} className={category === c ? 'seg on' : 'seg'} onClick={() => setCategory(c)}>
                    {PLACE_CATEGORY_META[c].label} <span className="board-count">{n}</span>
                  </button>
                )
              })}
            </span>
            <input className="search people-search" placeholder="Find a place…" value={q} onChange={e => setQ(e.target.value)} />
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
            <button className="btn subtle" onClick={() => setOpenId(null)} disabled={!openId}>
              Collapse
            </button>
          </div>

          <div className="kpi-row people-kpis">
            <div className="stat-tile">
              <div className="stat-label">Places</div>
              <div className="stat-value">{shown.length}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Outings this year</div>
              <div className="stat-value">{outingsThisYear}</div>
            </div>
            <div className="stat-tile" title="Places with a rhythm that are due or overdue a return">
              <div className="stat-label">Been a while</div>
              <div className="stat-value">{beenAWhile}</div>
            </div>
          </div>

          {shown.length === 0 ? (
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
                />
              ))}
            </ul>
          )}

          {shown.length > 0 && (
            <section className="chart-card year-report">
              <header className="chart-head">
                <div>
                  <h3>The year in places</h3>
                  <p className="chart-sub">Outings per month, a meal eaten out there included, two in one day counted as two · trend compares outings in the last 90 days with the 90 before</p>
                </div>
                <span className="segmented">
                  <button className="seg" onClick={() => setYear(y => y - 1)} aria-label="Previous year">
                    ‹
                  </button>
                  <button className="seg on">{year}</button>
                  <button className="seg" onClick={() => setYear(y => y + 1)} aria-label="Next year">
                    ›
                  </button>
                </span>
              </header>
              <div className="table-scroll">
                <table className="year-table">
                  <thead>
                    <tr>
                      <th>Place</th>
                      {MONTHS.map((m, i) => (
                        <th key={i} className="num">
                          {m}
                        </th>
                      ))}
                      <th className="num">Outings</th>
                      <th>Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.map(r => (
                      <tr key={r.place.id}>
                        <td>
                          <span className="pdot" style={{ background: r.place.color }} /> {r.place.name}
                        </td>
                        {r.months.map((n, i) => (
                          <td
                            key={i}
                            className="num year-cell"
                            title={n > 0 ? countOf(n, 'outing') : undefined}
                            style={n > 0 ? heatStyle(r.place.color, n, theme) : undefined}
                          >
                            {n || ''}
                          </td>
                        ))}
                        <td className="num">
                          <strong>{r.total}</strong>
                        </td>
                        <td>
                          <TrendBadge trend={r.trend} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {editing && <PlaceForm place={editing.place} onSave={onSave} onDelete={onDelete} onClose={() => setEditing(null)} />}
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
