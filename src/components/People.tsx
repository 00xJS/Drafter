import { useMemo, useState } from 'react'
import { CADENCE_META, Cadence, PROJECT_COLORS, Person, PersonGroup, PERSON_GROUPS, PERSON_GROUP_META, Task } from '../types'
import { newerStamp } from '../itemops'
import { PersonStats, SEEN_META, compareStats, personStats } from '../people'
import { fmtDate, fromLocalInput, uid } from '../utils'
import { ConfirmButton } from './ConfirmButton'
import { CatchUpIdea, suggestCatchUp } from '../ai'

interface Props {
  people: Person[]
  tasks: Task[]
  onSave(p: Person): void
  onDelete(id: string): void
  /** Create a done "visit" task for a person on a date. */
  onLogVisit(person: Person, atIso: string, note: string): void
  /** Start planning something with a person (opens a new task with them attached). */
  onPlan(person: Person, title?: string): void
  onOpenTask(t: Task): void
}

function PersonForm({ person, onSave, onClose }: { person?: Person; onSave(p: Person): void; onClose(): void }) {
  const [name, setName] = useState(person?.name ?? '')
  const [emoji, setEmoji] = useState(person?.emoji ?? '')
  const [group, setGroup] = useState<PersonGroup>(person?.group ?? 'family')
  const [cadence, setCadence] = useState<Cadence | ''>((person?.cadenceDays as Cadence | undefined) ?? '')
  const [color, setColor] = useState(person?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)])
  const [notes, setNotes] = useState(person?.notes ?? '')
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
      createdAt: person?.createdAt ?? now,
      updatedAt: person ? newerStamp(person.updatedAt) : now,
    })
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>{person ? 'Edit person' : 'Add a person'}</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
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
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Birthday, favourite restaurant, what to ask about next time…" />
          </label>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}

function LogVisit({ person, onLog, onClose }: { person: Person; onLog(atIso: string, note: string): void; onClose(): void }) {
  const today = new Date()
  const [date, setDate] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`)
  const [note, setNote] = useState('')
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Saw {person.name}</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>When</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>What did you do?</span>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Sunday lunch, walk in the park…" autoFocus />
          </label>
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
              onLog(fromLocalInput(`${date}T12:00`)!, note.trim())
              onClose()
            }}
          >
            Log it
          </button>
        </footer>
      </div>
    </div>
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

export function PersonCard({ stats, onEdit, onLog, onPlan, onOpenTask }: { stats: PersonStats; onEdit(): void; onLog(): void; onPlan(title?: string): void; onOpenTask(t: Task): void }) {
  const { person } = stats
  const meta = SEEN_META[stats.status]
  const [ideas, setIdeas] = useState<CatchUpIdea[] | null>(null)
  const [ideasBusy, setIdeasBusy] = useState(false)
  const [ideasError, setIdeasError] = useState('')
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
        }),
      )
    } catch (e) {
      setIdeasError((e as Error).message)
    } finally {
      setIdeasBusy(false)
    }
  }
  return (
    <article className="person-card">
      <header className="person-head">
        <span className="person-avatar" style={{ background: person.color }}>
          {person.emoji ?? person.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="person-title">
          <strong>{person.name}</strong>
          <small className="muted">
            {PERSON_GROUP_META[person.group]}
            {person.cadenceDays ? ` · aim: ${CADENCE_META[person.cadenceDays as Cadence] ?? `every ${person.cadenceDays} days`}` : ''}
          </small>
        </div>
        <span className="badge" style={{ background: meta.bg, color: meta.color }}>
          {meta.label}
        </span>
      </header>
      <p className="person-reason">{stats.reason}</p>
      <div className="person-stats">
        <Bars weekly={stats.weekly} color={person.color} />
        <span className="person-nums">
          <span>
            <strong>{stats.count30}</strong> <small>30d</small>
          </span>
          <span>
            <strong>{stats.count90}</strong> <small>90d</small>
          </span>
          <span>
            <strong>{stats.avgGapDays ? Math.round(stats.avgGapDays) : '—'}</strong> <small>avg gap</small>
          </span>
        </span>
      </div>
      {stats.visits.length > 0 && (
        <ul className="person-recent">
          {stats.visits.slice(0, 3).map(v => (
            <li key={v.task.id} onClick={() => onOpenTask(v.task)}>
              <span>{v.task.title || 'Visit'}</span>
              <small className="muted">{fmtDate(v.at)}</small>
            </li>
          ))}
        </ul>
      )}
      {ideas && (
        <ul className="person-ideas">
          {ideas.map(i => (
            <li key={i.title}>
              <button type="button" className="person-idea" onClick={() => onPlan(i.title)} title="Turn into a task">
                <strong>{i.title}</strong>
                <small>{i.why}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {ideasError && <p className="warn">{ideasError}</p>}
      <footer className="person-actions">
        <button className="btn" onClick={onLog}>
          Saw them
        </button>
        <button className="btn" onClick={() => onPlan()}>
          Plan something
        </button>
        <button className="btn subtle" disabled={ideasBusy} onClick={getIdeas} title="AI ideas for the next catch-up">
          {ideasBusy ? 'Thinking…' : '✨ Ideas'}
        </button>
        <span className="spacer" />
        <button className="btn subtle" onClick={onEdit}>
          Edit
        </button>
      </footer>
    </article>
  )
}

export function People({ people, tasks, onSave, onDelete, onLogVisit, onPlan, onOpenTask }: Props) {
  const [editing, setEditing] = useState<{ person?: Person } | null>(null)
  const [logging, setLogging] = useState<Person | null>(null)
  const stats = useMemo(() => people.map(p => personStats(p, tasks)).sort(compareStats), [people, tasks])
  const counts = useMemo(() => {
    const c = { overdue: 0, due: 0, often: 0 }
    for (const s of stats) if (s.status === 'overdue' || s.status === 'due' || s.status === 'often') c[s.status]++
    return c
  }, [stats])

  return (
    <section className="people">
      <div className="toolbar">
        <div>
          <h2 className="view-title">People</h2>
          <p className="chart-sub">Who you've seen, how often, and who's due a call. Attach people to any task, or log a visit here.</p>
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing({})}>
          + Add person
        </button>
      </div>
      {people.length === 0 ? (
        <div className="chart-card">
          <p className="empty">
            Add the people you want to keep close. Give each a rhythm ("every 2 weeks") and the Today page will nudge you when it slips,
            and flag when you're seeing someone a lot.
          </p>
        </div>
      ) : (
        <>
          {(counts.overdue > 0 || counts.due > 0 || counts.often > 0) && (
            <p className="people-summary">
              {counts.overdue > 0 && <span className="badge" style={{ background: SEEN_META.overdue.bg, color: SEEN_META.overdue.color }}>{counts.overdue} overdue</span>}
              {counts.due > 0 && <span className="badge" style={{ background: SEEN_META.due.bg, color: SEEN_META.due.color }}>{counts.due} due a catch-up</span>}
              {counts.often > 0 && <span className="badge" style={{ background: SEEN_META.often.bg, color: SEEN_META.often.color }}>{counts.often} seeing a lot</span>}
            </p>
          )}
          <div className="people-grid">
            {stats.map(s => (
              <PersonCard key={s.person.id} stats={s} onEdit={() => setEditing({ person: s.person })} onLog={() => setLogging(s.person)} onPlan={title => onPlan(s.person, title)} onOpenTask={onOpenTask} />
            ))}
          </div>
        </>
      )}

      {editing && (
        <PersonForm
          person={editing.person}
          onSave={onSave}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.person && (
        <div className="people-delete">
          <ConfirmButton className="btn subtle danger" confirmLabel="Click again to remove" onConfirm={() => {
            onDelete(editing.person!.id)
            setEditing(null)
          }}>
            Remove {editing.person.name}
          </ConfirmButton>
        </div>
      )}
      {logging && <LogVisit person={logging} onLog={(at, note) => onLogVisit(logging, at, note)} onClose={() => setLogging(null)} />}
    </section>
  )
}
