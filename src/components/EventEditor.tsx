import { useState } from 'react'
import { CalendarEntry, Person, WORK_MODES, WORK_MODE_META, WorkMode } from '../types'
import { newerStamp } from '../itemops'
import { uid } from '../utils'
import { expandWorkDays } from '../calendars'
import { Modal, ModalHead } from './Modal'
import { PeoplePicker } from './PeoplePicker'

// The one thing a task cannot express: a block of time with a start AND an end.
// Everything else on the calendar marks a moment (a due time, a meal, an
// occasion); this reserves a slot. A work day is the same record with a place
// attached — home or the office — and its start and end are the working hours.

/** 'YYYY-MM-DDTHH:MM' in local time, which is what <input type="datetime-local"> speaks. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(v: string): string | null {
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/** The day after a YYYY-MM-DD key. All-day ends are exclusive, per the ICS convention. */
function nextDayKey(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return key
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const pad = (n: number) => String(n).padStart(2, '0')

const dayKeyOf = (iso: string) => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.slice(0, 10)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 'HH:MM' in local time, which is what <input type="time"> speaks. */
const hmOf = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A local day plus a local 'HH:MM', as an instant. */
function atLocal(day: string, hm: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const t = /^(\d{1,2}):(\d{2})/.exec(hm)
  if (!m || !t) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2])).toISOString()
}

/** Monday first, the way a working week reads. `n` is Date.getDay(). */
const WEEKDAYS: { n: number; label: string }[] = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 0, label: 'Sun' },
]
const REPEAT_WEEKS = [1, 2, 4, 8, 12]

/** The rest of the form, which a work day and an event share. */
interface EntryFields {
  location: string
  notes: string
  work?: WorkMode
  peopleIds: string[]
}

/**
 * A full entry from the editor's fields. Editing keeps the id and creation
 * time. People are an event's: a work day keeps whatever it had, and an event
 * with nobody on it stores no list, just as entries did before they had people.
 */
export function buildEntry(
  entry: CalendarEntry | undefined,
  f: { title: string; start: string; end: string; allDay: boolean },
  rest: EntryFields,
  keepId: boolean,
): CalendarEntry {
  const now = new Date().toISOString()
  const editing = keepId ? entry : undefined
  return {
    kind: 'event',
    id: editing ? editing.id : uid(),
    title: f.title,
    start: f.start,
    end: f.end,
    allDay: f.allDay,
    location: rest.location.trim() || undefined,
    notes: rest.notes.trim() || undefined,
    projectId: entry?.projectId,
    peopleIds: rest.work ? entry?.peopleIds : rest.peopleIds.length > 0 ? rest.peopleIds : undefined,
    work: rest.work,
    createdAt: editing ? editing.createdAt : now,
    updatedAt: editing ? newerStamp(editing.updatedAt) : now,
  }
}

export function EventEditor({
  entry,
  defaultStartIso,
  defaultWork,
  people,
  onSavePerson,
  onSave,
  onDelete,
  onClose,
}: {
  /** Editing an existing entry, or undefined to create one. */
  entry?: CalendarEntry
  /** The slot the calendar was showing when this opened. */
  defaultStartIso: string
  /** Open straight into a work day, from the calendar's "Work day" button. */
  defaultWork?: WorkMode
  /** Who can be put on an event. */
  people: Person[]
  /** Save someone typed into People here who isn't in People yet. */
  onSavePerson?(p: Person): void
  /** One entry, or every day of a repeated work pattern. */
  onSave(entries: CalendarEntry[]): void
  onDelete?(id: string): void
  onClose(): void
}) {
  const [work, setWork] = useState<WorkMode | undefined>(entry ? entry.work : defaultWork)
  // A work day saved with its mode's default label ("Working from home") has an
  // automatic title, not a chosen one: start the field empty so the label follows
  // whichever mode is picked, or switching a home day to Office would keep
  // telling Google and Outlook it is a home day.
  const [title, setTitle] = useState(() =>
    entry?.work && entry.title === WORK_MODE_META[entry.work].label ? '' : (entry?.title ?? ''),
  )
  const [allDay, setAllDay] = useState(entry?.allDay ?? false)
  const [startLocal, setStartLocal] = useState(() => toLocalInput(entry && !entry.allDay ? entry.start : defaultStartIso))
  const [endLocal, setEndLocal] = useState(() =>
    toLocalInput(entry && !entry.allDay ? entry.end : new Date(Date.parse(defaultStartIso) + 3_600_000).toISOString()),
  )
  const [startDay, setStartDay] = useState(() => (entry?.allDay ? entry.start : dayKeyOf(entry?.start ?? defaultStartIso)))
  const [workDay, setWorkDay] = useState(() => dayKeyOf(entry?.start ?? defaultStartIso))
  const [from, setFrom] = useState(() => (entry?.work && !entry.allDay ? hmOf(entry.start) : '09:00'))
  const [to, setTo] = useState(() => (entry?.work && !entry.allDay ? hmOf(entry.end) : '17:30'))
  const [repeatDays, setRepeatDays] = useState<number[]>([])
  const [repeatWeeks, setRepeatWeeks] = useState(4)
  const [location, setLocation] = useState(entry?.location ?? '')
  const [notes, setNotes] = useState(entry?.notes ?? '')
  const [peopleIds, setPeopleIds] = useState<string[]>(entry?.peopleIds ?? [])
  const [error, setError] = useState('')

  const build = (f: { title: string; start: string; end: string; allDay: boolean }, keepId: boolean): CalendarEntry =>
    buildEntry(entry, f, { location, notes, work, peopleIds }, keepId)

  const saveWork = (mode: WorkMode) => {
    const name = title.trim() || WORK_MODE_META[mode].label
    const f = from.slice(0, 5)
    const t = to.slice(0, 5)
    if (!/^\d{2}:\d{2}$/.test(f) || !/^\d{2}:\d{2}$/.test(t)) {
      setError('Pick your working hours.')
      return
    }
    // zero-padded 'HH:MM' compares correctly as text
    if (t <= f) {
      setError('The working day has to end after it starts.')
      return
    }
    if (!entry && repeatDays.length > 0) {
      const days = expandWorkDays(workDay, repeatDays, repeatWeeks, f, t)
      if (days.length === 0) {
        setError('None of those weekdays fall in that range.')
        return
      }
      onSave(days.map(d => build({ title: name, start: d.start, end: d.end, allDay: false }, false)))
      onClose()
      return
    }
    const start = atLocal(workDay, f)
    const end = atLocal(workDay, t)
    if (!start || !end) {
      setError('Pick a day.')
      return
    }
    onSave([build({ title: name, start, end, allDay: false }, true)])
    onClose()
  }

  const saveEvent = () => {
    const name = title.trim()
    if (!name) {
      setError('Give it a title.')
      return
    }
    let start: string
    let end: string
    if (allDay) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay)) {
        setError('Pick a day.')
        return
      }
      start = startDay
      end = nextDayKey(startDay)
    } else {
      const s = fromLocalInput(startLocal)
      const e = fromLocalInput(endLocal)
      if (!s) {
        setError('Pick a start time.')
        return
      }
      // An end before the start would draw a backwards block. Say so rather
      // than silently repairing it — the user picked both.
      if (e && Date.parse(e) <= Date.parse(s)) {
        setError('The end has to be after the start.')
        return
      }
      start = s
      end = e ?? new Date(Date.parse(s) + 3_600_000).toISOString()
    }
    onSave([build({ title: name, start, end, allDay }, true)])
    onClose()
  }

  const save = () => (work ? saveWork(work) : saveEvent())
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') save()
  }
  const heading = entry ? (work ? 'Edit work day' : 'Edit event') : work ? 'New work day' : 'New event'

  return (
    <Modal onClose={onClose} className="modal event-modal">
      <ModalHead title={heading} />

      <div className="modal-body">
        {!entry && (
          <div className="event-kind segmented" role="group" aria-label="What kind of entry">
            <button type="button" className={work ? 'seg' : 'seg on'} aria-pressed={!work} onClick={() => setWork(undefined)}>
              🕘 Event
            </button>
            <button type="button" className={work ? 'seg on' : 'seg'} aria-pressed={!!work} onClick={() => setWork(w => w ?? 'home')}>
              🏠 Work day
            </button>
          </div>
        )}

        {work ? (
          <>
            <div className="field">
              <span>Where</span>
              <div className="segmented" role="group" aria-label="Where you are working">
                {WORK_MODES.map(m => (
                  <button key={m} type="button" className={work === m ? 'seg on' : 'seg'} aria-pressed={work === m} onClick={() => setWork(m)}>
                    {WORK_MODE_META[m].emoji} {WORK_MODE_META[m].short}
                  </button>
                ))}
              </div>
            </div>

            <label className="field">
              <span>{repeatDays.length > 0 ? 'Starting' : 'Day'}</span>
              <input type="date" value={workDay} onChange={e => setWorkDay(e.target.value)} />
            </label>

            <div className="work-hours">
              <label className="field">
                <span>From</span>
                <input type="time" value={from} onChange={e => setFrom(e.target.value)} />
              </label>
              <label className="field">
                <span>To</span>
                <input type="time" value={to} onChange={e => setTo(e.target.value)} />
              </label>
            </div>

            {!entry && (
              <div className="field">
                <span>Repeat on</span>
                <div className="work-days" role="group" aria-label="Repeat on these weekdays">
                  {WEEKDAYS.map(w => {
                    const on = repeatDays.includes(w.n)
                    return (
                      <button
                        key={w.n}
                        type="button"
                        className={'work-day-chip' + (on ? ' on' : '')}
                        aria-pressed={on}
                        onClick={() => setRepeatDays(ds => (on ? ds.filter(x => x !== w.n) : [...ds, w.n]))}
                      >
                        {w.label}
                      </button>
                    )
                  })}
                </div>
                {repeatDays.length > 0 && (
                  <label className="work-weeks">
                    <span>for</span>
                    <select value={repeatWeeks} onChange={e => setRepeatWeeks(Number(e.target.value))} aria-label="How many weeks">
                      {REPEAT_WEEKS.map(n => (
                        <option key={n} value={n}>
                          {n} week{n === 1 ? '' : 's'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}

            <label className="field">
              <span>Label</span>
              <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={onEnter} placeholder={WORK_MODE_META[work].label} />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span>Title</span>
              <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={onEnter} placeholder="Dentist" />
            </label>

            <label className="field-inline">
              <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />
              <span>All day</span>
            </label>

            {allDay ? (
              <label className="field">
                <span>Day</span>
                <input type="date" value={startDay} onChange={e => setStartDay(e.target.value)} />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>Starts</span>
                  <input type="datetime-local" value={startLocal} onChange={e => setStartLocal(e.target.value)} />
                </label>
                <label className="field">
                  <span>Ends</span>
                  <input type="datetime-local" value={endLocal} onChange={e => setEndLocal(e.target.value)} />
                </label>
              </>
            )}

            {/* who it is with: once it has happened it counts as seeing them,
                as Who was there? does for another calendar's event */}
            <PeoplePicker
              peopleIds={peopleIds}
              onChange={setPeopleIds}
              people={people}
              onSavePerson={onSavePerson}
              hint="once it has happened, it counts as seeing them"
              noun="event"
            />
          </>
        )}

        <label className="field">
          <span>Location</span>
          <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Optional" />
        </label>

        <label className="field">
          <span>Notes</span>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Optional" />
        </label>

        {error && <p className="form-error">{error}</p>}
      </div>

      <footer className="modal-foot">
        {entry && onDelete && (
          <button
            className="btn danger"
            onClick={() => {
              onDelete(entry.id)
              onClose()
            }}
          >
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn subtle" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </footer>
    </Modal>
  )
}
