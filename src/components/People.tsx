import { useMemo, useState } from 'react'
import { CADENCE_META, Cadence, CalendarEntry, JournalEntry, PLACE_CATEGORY_META, PROJECT_COLORS, Person, PersonGroup, PERSON_GROUPS, PERSON_GROUP_META, Place, Task } from '../types'
import { newerStamp } from '../itemops'
import { PersonStats, SEEN_META, compareStats, personStats, seenTasks, yearReport } from '../people'
import { PlaceWithPerson, favourites, placesWith } from '../places'
import { mentions } from '../journal'
import { fmtDate, fromLocalInput, uid } from '../utils'
import { ConfirmButton } from './ConfirmButton'
import { Modal, ModalHead } from './Modal'
import { CatchUpIdea, suggestCatchUp } from '../ai'

interface Props {
  people: Person[]
  places?: Place[]
  tasks: Task[]
  /** Your journal (personal): a person's card counts the days that were about them. */
  journal?: JournalEntry[]
  /** Jump to a day in the journal. */
  onOpenJournal?(date: string): void
  onSave(p: Person): void
  onDelete(id: string): void
  /** Create a done "visit" task for a person on a date. */
  onLogVisit(person: Person, atIso: string, note: string, placeId?: string): void
  /** Persist a new place (inline create from the Where picker). */
  onSavePlace?(p: Place): void
  /** Start planning something with a person (opens a new task with them attached). */
  onPlan(person: Person, title?: string): void
  onOpenTask(t: Task): void
  /** Your own calendar entries: one that has happened with people on it counts as seeing them. */
  entries?: CalendarEntry[]
  /** Open one of those entries, from the visit it counts as. */
  onOpenEntry?(e: CalendarEntry): void
}

type GroupFilter = 'all' | PersonGroup
type SortKey = 'attention' | 'az' | 'za' | 'never' | 'recent' | 'least'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'az', label: 'A to Z' },
  { key: 'za', label: 'Z to A' },
  { key: 'never', label: 'Not seen' },
  { key: 'recent', label: 'Most recently seen' },
  { key: 'least', label: 'Least recently seen' },
]

function PersonForm({ person, onSave, onDelete, onClose }: { person?: Person; onSave(p: Person): void; onDelete?(id: string): void; onClose(): void }) {
  const [name, setName] = useState(person?.name ?? '')
  const [emoji, setEmoji] = useState(person?.emoji ?? '')
  const [group, setGroup] = useState<PersonGroup>(person?.group ?? 'family')
  const [cadence, setCadence] = useState<Cadence | ''>((person?.cadenceDays as Cadence | undefined) ?? '')
  const [color, setColor] = useState(person?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)])
  const [notes, setNotes] = useState(person?.notes ?? '')
  const [birthday, setBirthday] = useState(person?.birthday ?? '')
  const [anniversary, setAnniversary] = useState(person?.anniversary ?? '')
  const save = () => {
    if (!name.trim()) return
    const now = new Date().toISOString()
    onSave({
      kind: 'person',
      id: person?.id ?? uid(),
      name: name.trim(),
      emoji: emoji.trim() || undefined,
      group,
      color,
      cadenceDays: cadence === '' ? undefined : cadence,
      notes: notes.trim() || undefined,
      birthday: birthday || undefined,
      anniversary: anniversary || undefined,
      createdAt: person?.createdAt ?? now,
      updatedAt: person ? newerStamp(person.updatedAt) : now,
    })
    onClose()
  }
  return (
    <Modal onClose={onClose} className="modal narrow">
      <ModalHead title={person ? `Edit ${person.name}` : 'Add a person'} />
      <div className="modal-body">
        <div className="field-row">
          <label className="field emoji-field">
            <span>Icon</span>
            <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="👵" maxLength={4} />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Mum" autoFocus />
          </label>
        </div>
        <div className="field">
          <span>Group</span>
          <div className="segmented">
            {PERSON_GROUPS.map(g => (
              <button key={g} type="button" className={group === g ? 'seg on' : 'seg'} onClick={() => setGroup(g)}>
                {PERSON_GROUP_META[g]}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>
            How often do you want to see them? <small>(drives the nudges)</small>
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
        <div className="field-row">
          <label className="field">
            <span>Birthday</span>
            <input type="date" value={birthday} onChange={e => setBirthday(e.target.value)} />
          </label>
          <label className="field">
            <span>Anniversary</span>
            <input type="date" value={anniversary} onChange={e => setAnniversary(e.target.value)} />
          </label>
        </div>
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
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Favourite restaurant, gift ideas, what to ask about next time…" />
        </label>
      </div>
      <footer className="modal-foot">
        {person && onDelete && (
          <ConfirmButton
            className="btn subtle danger"
            confirmLabel="Click again to remove"
            onConfirm={() => {
              onDelete(person.id)
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
        <button className="btn primary" disabled={!name.trim()} onClick={save}>
          Save
        </button>
      </footer>
    </Modal>
  )
}

function LogVisit({
  person,
  places,
  onLog,
  onSavePlace,
  onClose,
}: {
  person: Person
  places: Place[]
  onLog(atIso: string, note: string, placeId?: string): void
  onSavePlace?(p: Place): void
  onClose(): void
}) {
  const today = new Date()
  const [date, setDate] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`)
  const [note, setNote] = useState('')
  const [placeId, setPlaceId] = useState<string | undefined>()
  const [placeQuery, setPlaceQuery] = useState('')
  const selected = placeId ? places.find(p => p.id === placeId) : undefined
  const matches = placeQuery.trim()
    ? places.filter(p => p.id !== placeId && p.name.toLowerCase().includes(placeQuery.trim().toLowerCase())).slice(0, 8)
    : []
  const canCreate = !!placeQuery.trim() && !places.some(p => p.name.toLowerCase() === placeQuery.trim().toLowerCase()) && !!onSavePlace
  return (
    <Modal onClose={onClose} className="modal narrow">
      <ModalHead title={`Saw ${person.name}`} />
      <div className="modal-body">
        <label className="field">
          <span>When</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>What did you do?</span>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Sunday lunch, walk in the park…" autoFocus />
        </label>
        {(places.length > 0 || onSavePlace) && (
          <div className="field">
            <span>Where?</span>
            {selected && (
              <div className="platform-toggles attendees">
                <button type="button" className="toggle on" onClick={() => setPlaceId(undefined)} title="Remove">
                  {selected.emoji ? `${selected.emoji} ` : ''}
                  {selected.name} ✕
                </button>
              </div>
            )}
            {!selected && (
              <>
                <input
                  className="people-picker-search"
                  value={placeQuery}
                  onChange={e => setPlaceQuery(e.target.value)}
                  placeholder="Search places…"
                />
                {(placeQuery.trim() || canCreate) && (
                  <div className="platform-toggles picker-results">
                    {matches.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        className="toggle"
                        onClick={() => {
                          setPlaceId(p.id)
                          setPlaceQuery('')
                        }}
                      >
                        {p.emoji ? `${p.emoji} ` : ''}
                        {p.name}
                      </button>
                    ))}
                    {canCreate && (
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
                          onSavePlace!(p)
                          setPlaceId(p.id)
                          setPlaceQuery('')
                        }}
                      >
                        Create place “{placeQuery.trim()}”
                      </button>
                    )}
                    {!canCreate && matches.length === 0 && placeQuery.trim() && <small className="muted">No match.</small>}
                  </div>
                )}
              </>
            )}
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
            onLog(fromLocalInput(`${date}T12:00`)!, note.trim(), placeId)
            onClose()
          }}
        >
          Log it
        </button>
      </footer>
    </Modal>
  )
}

function Bars({ weekly, color }: { weekly: number[]; color: string }) {
  const max = Math.max(1, ...weekly)
  return (
    <span className="person-bars" title="Visits per week, last 12 weeks">
      {weekly.map((n, i) => (
        <span key={i} className="person-bar" style={{ height: `${n === 0 ? 8 : 20 + (n / max) * 80}%`, background: n === 0 ? undefined : color, opacity: n === 0 ? 0.35 : 1 }} />
      ))}
    </span>
  )
}

export { Bars }

/**
 * One person as a compact row. Details and the action buttons live behind the
 * row's own disclosure, so forty people stay scannable instead of becoming
 * forty identical cards each repeating the same four buttons.
 */
function PersonRow({
  stats,
  open,
  onToggle,
  onEdit,
  onLog,
  onPlan,
  onOpenTask,
  placesTogether,
  favouriteNames,
  journal,
  onOpenJournal,
}: {
  stats: PersonStats
  open: boolean
  onToggle(): void
  onEdit(): void
  onLog(): void
  onPlan(title?: string): void
  onOpenTask(t: Task): void
  /** Where you go with this person, most often first. */
  placesTogether?: PlaceWithPerson[]
  /** Your favourite places overall — the ones they haven't been to become suggestions. */
  favouriteNames?: string[]
  journal?: JournalEntry[]
  onOpenJournal?(date: string): void
}) {
  const { person } = stats
  const meta = SEEN_META[stats.status]
  const [ideas, setIdeas] = useState<CatchUpIdea[] | null>(null)
  const [ideasBusy, setIdeasBusy] = useState(false)
  const [ideasError, setIdeasError] = useState('')
  const together = placesTogether ?? []
  // Journal mentions are "this day was about them", not visits: they are shown
  // on their own line and never reach visitsFor / seenStatus / personStats,
  // the cadence badge or the digest's people nudges.
  const inJournal = useMemo(() => (open && journal ? mentions(journal, person.id) : []), [open, journal, person.id])

  const getIdeas = async () => {
    setIdeasBusy(true)
    setIdeasError('')
    try {
      setIdeas(
        await suggestCatchUp({
          name: person.name,
          group: person.group,
          notes: person.notes,
          daysSince: stats.daysSince,
          recent: stats.visits.slice(0, 5).map(v => ({ what: v.task.title || 'a visit', when: fmtDate(v.at) })),
          places: together.slice(0, 5).map(r => ({ name: r.place.name, category: PLACE_CATEGORY_META[r.place.category].label, times: r.count, lastWent: fmtDate(r.lastAt) })),
          notYetTogether: (favouriteNames ?? []).filter(n => !together.some(r => r.place.name === n)).slice(0, 3),
        }),
      )
    } catch (e) {
      setIdeasError((e as Error).message)
    } finally {
      setIdeasBusy(false)
    }
  }

  return (
    <li className={open ? 'person-row open' : 'person-row'}>
      <button className="person-summary" onClick={onToggle} aria-expanded={open}>
        <span className="person-avatar" style={{ background: person.color }}>
          {person.emoji ?? person.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="person-ident">
          <strong>{person.name}</strong>
          <small className="muted">{stats.reason}</small>
        </span>
        <span className="person-inline-stats">
          <span title="Visits in the last 30 days">
            <strong>{stats.count30}</strong>
            <small>30d</small>
          </span>
          <span title="Visits in the last 90 days">
            <strong>{stats.count90}</strong>
            <small>90d</small>
          </span>
        </span>
        <span className="badge" style={{ background: meta.bg, color: meta.color }}>
          {meta.label}
        </span>
        <span className="person-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="person-detail">
          <div className="person-stats">
            <Bars weekly={stats.weekly} color={person.color} />
            <span className="person-nums">
              <span>
                <strong>{stats.avgGapDays ? Math.round(stats.avgGapDays) : '—'}</strong>
                <small>avg gap</small>
              </span>
              <span>
                <strong>{person.cadenceDays ?? '90 (default)'}</strong>
                <small>target</small>
              </span>
              <span>
                <strong>{stats.visits.length}</strong>
                <small>all time</small>
              </span>
            </span>
          </div>

          {stats.visits.length > 0 && (
            <ul className="person-recent">
              {stats.visits.slice(0, 4).map(v => (
                <li key={v.task.id} onClick={() => onOpenTask(v.task)}>
                  <button type="button" className="row-open">
                    <span>{v.task.title || 'Visit'}</span>
                  </button>
                  <small className="muted">{fmtDate(v.at)}</small>
                </li>
              ))}
            </ul>
          )}

          {inJournal.length > 0 && (
            <p className="person-journal">
              <span className="muted">In your journal: </span>
              {inJournal.length} {inJournal.length === 1 ? 'entry' : 'entries'} · last {fmtDate(`${inJournal[0].date}T12:00`)}
              {onOpenJournal && (
                <button type="button" className="btn subtle" onClick={() => onOpenJournal(inJournal[0].date)}>
                  Open
                </button>
              )}
            </p>
          )}

          {together.length > 0 && (
            <div className="field">
              <span className="muted">Where we go</span>
              <div className="platform-toggles attendees">
                {together.slice(0, 4).map(r => (
                  <span key={r.place.id} className="toggle on" style={{ cursor: 'default' }} title={`Last ${fmtDate(r.lastAt)}`}>
                    {r.place.emoji ? `${r.place.emoji} ` : ''}
                    {r.place.name}
                    <small className="muted"> ×{r.count}</small>
                  </span>
                ))}
              </div>
            </div>
          )}

          {ideas && (
            <ul className="person-ideas">
              {ideas.map((i, idx) => (
                <li key={`${idx}:${i.title}`}>
                  <button type="button" className="person-idea" onClick={() => onPlan(i.title)} title="Turn into a task">
                    <strong>{i.title}</strong>
                    <small>{i.why}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {ideasError && <p className="warn">{ideasError}</p>}

          <div className="person-actions">
            <button className="btn" onClick={onLog}>
              Saw them
            </button>
            <button className="btn" onClick={() => onPlan()}>
              Plan something
            </button>
            <button className="btn" disabled={ideasBusy} onClick={getIdeas}>
              {ideasBusy ? 'Thinking…' : '✨ Ideas'}
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

const NO_ENTRIES: CalendarEntry[] = []

export function People({ people, places = [], tasks, entries = NO_ENTRIES, journal, onOpenJournal, onSave, onDelete, onLogVisit, onSavePlace, onPlan, onOpenTask, onOpenEntry }: Props) {
  const [editing, setEditing] = useState<{ person?: Person } | null>(null)
  const [logging, setLogging] = useState<Person | null>(null)
  const [group, setGroup] = useState<GroupFilter>('all')
  const [sort, setSort] = useState<SortKey>('attention')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [year, setYear] = useState(() => new Date().getFullYear())

  // An event of your own counts as seeing the people on it once it has
  // happened, the way a subscribed calendar's does once Who was there? logs
  // them: read as the visit task that would have been logged, it reaches
  // every number below. Places still come from tasks: an event names none.
  const seen = useMemo(() => seenTasks(tasks, entries), [tasks, entries])
  const allStats = useMemo(() => people.map(p => personStats(p, seen)), [people, seen])
  const favouriteNames = useMemo(() => favourites(places, tasks, people).map(s => s.place.name), [places, tasks, people])

  // a visit an event made opens that event: it is not a task, and saved as
  // one it would be written over the event
  const openVisit = (t: Task) => {
    const entry = entries.find(e => e.id === t.id)
    if (!entry) onOpenTask(t)
    else onOpenEntry?.(entry)
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = allStats
      .filter(s => group === 'all' || s.person.group === group)
      .filter(s => !needle || s.person.name.toLowerCase().includes(needle) || (s.person.notes ?? '').toLowerCase().includes(needle))
    const byName = (a: PersonStats, b: PersonStats) => a.person.name.localeCompare(b.person.name)
    const sorted = [...list]
    if (sort === 'az') sorted.sort(byName)
    else if (sort === 'za') sorted.sort((a, b) => byName(b, a))
    // never-logged first, then the ones you have seen least recently
    else if (sort === 'never') sorted.sort((a, b) => Number(!!a.lastSeen) - Number(!!b.lastSeen) || (a.lastSeen ?? '').localeCompare(b.lastSeen ?? '') || byName(a, b))
    // a person with no visit on record has no "last seen" to rank, so they sit
    // at the end of both date sorts — 'Not seen' is the option that surfaces them
    else if (sort === 'recent' || sort === 'least')
      sorted.sort((a, b) => {
        if (!a.lastSeen || !b.lastSeen) return Number(!!b.lastSeen) - Number(!!a.lastSeen) || byName(a, b)
        return (sort === 'recent' ? b.lastSeen.localeCompare(a.lastSeen) : a.lastSeen.localeCompare(b.lastSeen)) || byName(a, b)
      })
    else sorted.sort(compareStats)
    return sorted
  }, [allStats, group, sort, q])

  /**
   * Two numbers that are easy to conflate: one dinner with three relatives is
   * ONE occasion but THREE person-visits. Showing both explains the gap you
   * notice when the same event involves several people.
   */
  const counts = useMemo(() => {
    const scoped = new Set(shown.map(s => s.person.id))
    const occasions = new Set<string>()
    let personVisits = 0
    for (const t of seen) {
      if (t.status !== 'done' || !t.completedAt) continue
      const involved = (t.peopleIds ?? []).filter(id => scoped.has(id))
      if (involved.length === 0) continue
      occasions.add(t.id)
      personVisits += involved.length
    }
    const attention = { overdue: 0, due: 0 }
    for (const s of shown) if (s.status === 'overdue' || s.status === 'due') attention[s.status]++
    return { occasions: occasions.size, personVisits, attention }
  }, [shown, seen])

  const report = useMemo(() => yearReport(shown.map(s => s.person), seen, year), [shown, seen, year])
  const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

  return (
    <section className="people">
      <div className="toolbar people-toolbar">
        <div>
          <h2 className="view-title">People</h2>
          <p className="chart-sub">Who you've seen, how often, and who's due a call.</p>
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing({})}>
          + Add person
        </button>
      </div>

      {people.length === 0 ? (
        <div className="chart-card">
          <p className="empty">
            Add the people you want to keep close. Give each a rhythm ("every 2 weeks") and Today will nudge you when it slips.
          </p>
        </div>
      ) : (
        <>
          <div className="people-controls">
            <span className="segmented">
              <button className={group === 'all' ? 'seg on' : 'seg'} onClick={() => setGroup('all')}>
                All <span className="board-count">{allStats.length}</span>
              </button>
              {PERSON_GROUPS.map(g => (
                <button key={g} className={group === g ? 'seg on' : 'seg'} onClick={() => setGroup(g)}>
                  {PERSON_GROUP_META[g]} <span className="board-count">{allStats.filter(s => s.person.group === g).length}</span>
                </button>
              ))}
            </span>
            <input className="search people-search" placeholder="Find a person…" value={q} onChange={e => setQ(e.target.value)} />
            <label className="people-sort">
              Sort
              <select value={sort} onChange={e => setSort(e.target.value as SortKey)}>
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
              <div className="stat-label">Occasions</div>
              <div className="stat-value">{counts.occasions}</div>
              <div className="stat-sub">get-togethers logged</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">People seen</div>
              <div className="stat-value">{counts.personVisits}</div>
              <div className="stat-sub">counted once per person, per occasion</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Overdue</div>
              <div className={counts.attention.overdue ? 'stat-value stat-warn' : 'stat-value'}>{counts.attention.overdue}</div>
              <div className="stat-sub">past your target rhythm</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Due a catch-up</div>
              <div className="stat-value">{counts.attention.due}</div>
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="empty">Nobody matches.</p>
          ) : (
            <ul className="people-list">
              {shown.map(s => (
                <PersonRow
                  key={s.person.id}
                  stats={s}
                  open={openId === s.person.id}
                  onToggle={() => setOpenId(cur => (cur === s.person.id ? null : s.person.id))}
                  onEdit={() => setEditing({ person: s.person })}
                  onLog={() => setLogging(s.person)}
                  onPlan={title => onPlan(s.person, title)}
                  onOpenTask={openVisit}
                  placesTogether={places.length ? placesWith(s.person.id, places, tasks) : undefined}
                  favouriteNames={favouriteNames}
                  journal={journal}
                  onOpenJournal={onOpenJournal}
                />
              ))}
            </ul>
          )}

          <section className="chart-card year-report">
            <header className="chart-head">
              <div>
                <h3>The year with {group === 'all' ? 'people' : PERSON_GROUP_META[group].toLowerCase()}</h3>
                <p className="chart-sub">Visits per month · trend compares the last 90 days with the 90 before</p>
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
                    <th>Person</th>
                    {MONTHS.map((m, i) => (
                      <th key={i} className="num">
                        {m}
                      </th>
                    ))}
                    <th className="num">Total</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {report.map(r => (
                    <tr key={r.person.id}>
                      <td>
                        <span className="pdot" style={{ background: r.person.color }} /> {r.person.name}
                      </td>
                      {r.months.map((n, i) => (
                        <td key={i} className="num year-cell" style={n > 0 ? { background: `color-mix(in srgb, ${r.person.color} ${Math.min(90, 25 + n * 20)}%, transparent)` } : undefined}>
                          {n || ''}
                        </td>
                      ))}
                      <td className="num">
                        <strong>{r.total}</strong>
                      </td>
                      <td>
                        {r.trend > 0 ? (
                          <span className="badge" style={{ background: 'rgba(14, 165, 233, 0.2)', color: '#7dd3fc' }}>
                            ↑ more lately
                          </span>
                        ) : r.trend < 0 ? (
                          <span className="badge" style={{ background: SEEN_META.due.bg, color: SEEN_META.due.color }}>
                            ↓ drifting
                          </span>
                        ) : (
                          <small className="muted">steady</small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {editing && <PersonForm person={editing.person} onSave={onSave} onDelete={onDelete} onClose={() => setEditing(null)} />}
      {logging && (
        <LogVisit
          person={logging}
          places={places}
          onSavePlace={onSavePlace}
          onLog={(at, note, placeId) => onLogVisit(logging, at, note, placeId)}
          onClose={() => setLogging(null)}
        />
      )}
    </section>
  )
}
