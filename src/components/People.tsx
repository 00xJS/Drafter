import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { CADENCE_META, Cadence, CalendarEntry, JournalEntry, PLACE_CATEGORY_META, PROJECT_COLORS, Person, PersonGroup, PERSON_GROUPS, PERSON_GROUP_META, Place, Task } from '../types'
import { newerStamp } from '../itemops'
import { PersonFilter, PersonStats, SEEN_META, cadenceChoice, compareStats, countOf, personMatcher, personStats, seenLabel, seenTasks } from '../people'
import { PlaceWithPerson, favourites, placesWith } from '../places'
import { localDayKey, mentions } from '../journal'
import { fmtDate, fromLocalInput, uid } from '../utils'
import { Bars } from './bits'
import { ConfirmButton } from './ConfirmButton'
import { Modal, ModalHead } from './Modal'
import { PlacePicker } from './PlacePicker'
import { CatchUpIdea, suggestCatchUp } from '../ai'
import { useDayKey } from '../useDayKey'
import { timeOn } from '../useDayClock'

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
  /** Open a place on Places, from a person's "Where we go". */
  onOpenPlace?(p: Place): void
  /** Start planning something with a person (opens a new task with them attached). */
  onPlan(person: Person, title?: string): void
  onOpenTask(t: Task): void
  /** Your own calendar entries: one that has happened with people on it counts as seeing them. */
  entries?: CalendarEntry[]
  /** Open one of those entries, from the visit it counts as. */
  onOpenEntry?(e: CalendarEntry): void
  /**
   * Whose log this list reads. The address book is the household's — one Mum —
   * but who saw whom is each member's own (v3.24), so every figure on a row
   * counts the visits this account wrote or was handed, and nobody else's.
   */
  myId?: string | null
  /** A person whose card opens on arrival (from search); consumed once. */
  openId?: string | null
  onOpenConsumed?(): void
  /** Open the add form from the List · Stats row; consumed once. */
  openAdd?: boolean
  onAddConsumed?(): void
  /**
   * The group chip and find box. The shell holds them rather than the
   * list, so People → Stats counts the rows they leave and List → Stats →
   * List keeps them.
   */
  filter: PersonFilter
  onFilter(filter: PersonFilter): void
}

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
  // '' is none set (the 90-day default), 'off' is No reminders
  const [cadence, setCadence] = useState<Cadence | '' | 'off'>(person?.noReminders ? 'off' : ((person?.cadenceDays as Cadence | undefined) ?? ''))
  const [color, setColor] = useState(() => person?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)])
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
      cadenceDays: cadence === '' || cadence === 'off' ? undefined : cadence,
      noReminders: cadence === 'off' || undefined,
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
          <select value={cadence} onChange={e => setCadence(cadenceChoice(e.target.value))}>
            <option value="">None set — about every 3 months</option>
            {(Object.keys(CADENCE_META).map(Number) as Cadence[]).map(c => (
              <option key={c} value={c}>
                {CADENCE_META[c]}
              </option>
            ))}
            <option value="off">No reminders</option>
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
  // today, read once as the sheet opens: a clock read as it renders is one
  // the React Compiler would keep for as long as the sheet is open
  const [date, setDate] = useState(() => localDayKey())
  const [note, setNote] = useState('')
  const [placeId, setPlaceId] = useState<string | undefined>()
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
        {(places.length > 0 || onSavePlace) && <PlacePicker placeId={placeId} onChange={setPlaceId} places={places} onSavePlace={onSavePlace} label="Where?" />}
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

/** Days seen in the last `span` days, and the events under them when some shared a day. */
function SeenCount({ days, events, span, className }: { days: number; events: number; span: number; className?: string }) {
  return (
    <span className={className} title={`Last ${span} days: ${seenLabel(days, events)}`}>
      <strong>{days}</strong>
      <small>
        {days === 1 ? 'day' : 'days'} · {span}d
      </small>
      {events !== days && <small className="person-events">{countOf(events, 'event')}</small>}
    </span>
  )
}

/**
 * One person as a compact row. Details and the action buttons live behind the
 * row's own disclosure, so forty people stay scannable instead of becoming
 * forty identical cards each repeating the same four buttons.
 */
export function PersonRow({
  stats,
  open,
  onToggle,
  onEdit,
  onLog,
  onPlan,
  onOpenTask,
  placesTogether,
  onOpenPlace,
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
  /** Open one of those places on Places. Without it the chips only say where. */
  onOpenPlace?(p: Place): void
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

  // A chain rather than try/catch/finally, which the React Compiler cannot
  // compile: the question is put together inside it, so a failure there is
  // said on the row as well, and the button is freed whatever happened.
  const getIdeas = () => {
    setIdeasBusy(true)
    setIdeasError('')
    void Promise.resolve()
      .then(() =>
        suggestCatchUp({
          name: person.name,
          group: person.group,
          notes: person.notes,
          daysSince: stats.daysSince,
          recent: stats.visits.slice(0, 5).map(v => ({ what: v.task.title || 'a visit', when: fmtDate(v.at) })),
          places: together.slice(0, 5).map(r => ({ name: r.place.name, category: PLACE_CATEGORY_META[r.place.category].label, times: r.count, lastWent: fmtDate(r.lastAt) })),
          notYetTogether: (favouriteNames ?? []).filter(n => !together.some(r => r.place.name === n)).slice(0, 3),
        }),
      )
      .then(setIdeas, (e: Error) => setIdeasError(e.message))
      .then(() => setIdeasBusy(false))
  }

  return (
    <li id={`person-${person.id}`} className={open ? 'person-row open' : 'person-row'}>
      <button className="person-summary" onClick={onToggle} aria-expanded={open}>
        <span className="person-avatar" style={{ background: person.color }}>
          {person.emoji ?? person.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="person-ident">
          <strong>{person.name}</strong>
          <small className="muted">{stats.reason}</small>
        </span>
        <span className="person-inline-stats">
          <SeenCount days={stats.days30} events={stats.count30} span={30} />
          <SeenCount days={stats.days90} events={stats.count90} span={90} />
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
          <div className="person-stats seen-stats">
            <Bars weekly={stats.weekly} color={person.color} title="Days seen per week, last 12 weeks" />
            <span className="person-nums">
              <span title="Average days between the days you saw them, over the last year">
                <strong>{stats.avgGapDays ? Math.round(stats.avgGapDays) : '—'}</strong>
                <small>avg gap</small>
              </span>
              <span>
                <strong>{person.noReminders ? 'Off' : (person.cadenceDays ?? '90 (default)')}</strong>
                <small>{person.noReminders ? 'reminders' : 'target'}</small>
              </span>
              {/* a phone's row hides its 30/90-day figures, so they show here instead */}
              <SeenCount className="seen-window" days={stats.days30} events={stats.count30} span={30} />
              <SeenCount className="seen-window" days={stats.days90} events={stats.count90} span={90} />
              <span>
                <strong>
                  {countOf(stats.daysAll, 'day')} · {countOf(stats.eventsAll, 'event')}
                </strong>
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
                {together.slice(0, 4).map(r => {
                  const chip = (
                    <>
                      {r.place.emoji ? `${r.place.emoji} ` : ''}
                      {r.place.name}
                      <small className="muted"> ×{r.count}</small>
                    </>
                  )
                  // a chip opens its place on Places, with its row open
                  return onOpenPlace ? (
                    <button key={r.place.id} type="button" className="toggle on" title={`Last ${fmtDate(r.lastAt)} · open in Places`} onClick={() => onOpenPlace(r.place)}>
                      {chip}
                    </button>
                  ) : (
                    <span key={r.place.id} className="toggle on" style={{ cursor: 'default' }} title={`Last ${fmtDate(r.lastAt)}`}>
                      {chip}
                    </span>
                  )
                })}
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

export function People({ people, places = [], tasks, entries = NO_ENTRIES, journal, myId, onOpenJournal, onSave, onDelete, onLogVisit, onSavePlace, onOpenPlace, onPlan, onOpenTask, onOpenEntry, openId: wantOpen, onOpenConsumed, openAdd, onAddConsumed, filter, onFilter }: Props) {
  const [editing, setEditing] = useState<{ person?: Person } | null>(() => (openAdd ? {} : null))
  const [logging, setLogging] = useState<Person | null>(null)
  const [sort, setSort] = useState<SortKey>('attention')
  // a card asked for opens with the first paint when People mounts for it
  const [openId, setOpenId] = useState<string | null>(() => wantOpen ?? null)
  /** The whole list folded away. Not remembered: a hidden list you did not hide is worse than a long one. */
  const [listShut, setListShut] = useState(false)

  // A card or the add sheet asked for while this is already on screen opens
  // as the ask arrives. The People tab clears the find box and the group chip as
  // the card is asked for, so neither hides it.
  const [asked, setAsked] = useState({ wantOpen, openAdd })
  if (asked.wantOpen !== wantOpen || asked.openAdd !== openAdd) {
    setAsked({ wantOpen, openAdd })
    if (wantOpen && wantOpen !== asked.wantOpen) setOpenId(wantOpen)
    if (openAdd && !asked.openAdd) setEditing({})
  }
  // Once per ask: the parent's setters are told as an ask is taken, and a new
  // setter alone is no new ask
  const openConsumed = useEffectEvent(() => onOpenConsumed?.())
  const addConsumed = useEffectEvent(() => onAddConsumed?.())
  useEffect(() => {
    if (!wantOpen) return
    // a long list can hold the row below the fold; one already in view stays put
    window.setTimeout(() => document.getElementById(`person-${wantOpen}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60)
    openConsumed()
  }, [wantOpen])
  useEffect(() => {
    if (openAdd) addConsumed()
  }, [openAdd])
  // An event of your own counts as seeing the people on it once it has
  // happened, the way a subscribed calendar's does once Who was there? logs
  // them: read as the visit task that would have been logged, it reaches
  // every number below. Places still come from tasks: an event names none.
  // Counted at the time they change, and again when the day does.
  const today = useDayKey()
  const allStats = useMemo(() => {
    const now = timeOn(today)
    const seen = seenTasks(tasks, entries, now, myId)
    return people.map(p => personStats(p, seen, now))
  }, [people, tasks, entries, myId, today])
  const favouriteNames = useMemo(() => favourites(places, tasks, people).map(s => s.place.name), [places, tasks, people])

  // a visit an event made opens that event: it is not a task, and saved as
  // one it would be written over the event
  const openVisit = (t: Task) => {
    const entry = entries.find(e => e.id === t.id)
    if (!entry) onOpenTask(t)
    else onOpenEntry?.(entry)
  }

  const shown = useMemo(() => {
    // People → Stats counts by this same rule, so its figures and these rows agree
    const matches = personMatcher(filter)
    const list = allStats.filter(s => matches(s.person))
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
  }, [allStats, filter, sort])

  // The tiles that counted days together, occasions, people seen and who is
  // due, and the year with people, are on People → Stats (PeopleStats), so
  // the list is the people and nothing else.
  return (
    <section className="people">
      <div className="toolbar people-toolbar">
        <div>
          <h2 className="view-title">People</h2>
          <p className="chart-sub">Who you've seen, how often, and who's due a call.</p>
        </div>
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
              <button className={filter.group === 'all' ? 'seg on' : 'seg'} onClick={() => onFilter({ ...filter, group: 'all' })}>
                All <span className="board-count">{allStats.length}</span>
              </button>
              {PERSON_GROUPS.map(g => (
                <button key={g} className={filter.group === g ? 'seg on' : 'seg'} onClick={() => onFilter({ ...filter, group: g })}>
                  {PERSON_GROUP_META[g]} <span className="board-count">{allStats.filter(s => s.person.group === g).length}</span>
                </button>
              ))}
            </span>
            <input className="search people-search" placeholder="Find a person…" value={filter.q} onChange={e => onFilter({ ...filter, q: e.target.value })} />
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
            {/* Two different things used to be one disabled button. Collapse
                shuts the card that is open, and was greyed out the rest of the
                time — which reads as broken; Hide list folds the whole list
                away, which is what "collapse the people" meant on a page with
                thirty-odd rows. Neither is ever disabled. */}
            {openId && (
              <button className="btn" onClick={() => setOpenId(null)}>
                Collapse card
              </button>
            )}
            <button className="btn" aria-expanded={!listShut} onClick={() => setListShut(v => !v)}>
              {listShut ? `Show ${countOf(shown.length, 'person', 'people')}` : 'Hide list'}
            </button>
          </div>

          {listShut ? (
            <p className="empty">
              {countOf(shown.length, 'person', 'people')} hidden.{' '}
              <button type="button" className="btn subtle" onClick={() => setListShut(false)}>
                Show them
              </button>
            </p>
          ) : shown.length === 0 ? (
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
                  onOpenPlace={onOpenPlace}
                  favouriteNames={favouriteNames}
                  journal={journal}
                  onOpenJournal={onOpenJournal}
                />
              ))}
            </ul>
          )}

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
