import { useMemo, useState } from 'react'
import {
  PLACE_CATEGORIES,
  PLACE_CATEGORY_META,
  PROJECT_COLORS,
  Person,
  Place,
  PlaceCategory,
  Task,
} from '../types'
import { newerStamp } from '../itemops'
import { PlaceStats, placeStats } from '../places'
import { Bars } from './People'
import { fmtDate, fromLocalInput, uid } from '../utils'
import { ConfirmButton } from './ConfirmButton'

interface Props {
  places: Place[]
  people: Person[]
  tasks: Task[]
  onSave(p: Place): void
  onDelete(id: string): void
  onLogOuting(place: Place, atIso: string, note: string, peopleIds: string[]): void
  onPlan(place: Place): void
  onOpenTask(t: Task): void
}

type CategoryFilter = 'all' | PlaceCategory
type SortKey = 'recent' | 'most' | 'az' | 'za' | 'longest'

// Same wording as the People sort, with "been" instead of "seen".
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'az', label: 'A to Z' },
  { key: 'za', label: 'Z to A' },
  { key: 'recent', label: 'Most recently been' },
  { key: 'longest', label: 'Least recently been' },
  { key: 'most', label: 'Most visited' },
]

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
  const [category, setCategory] = useState<PlaceCategory>(place?.category ?? 'restaurant')
  const [color, setColor] = useState(place?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)])
  const [notes, setNotes] = useState(place?.notes ?? '')
  const save = () => {
    if (!name.trim()) return
    const now = new Date().toISOString()
    onSave({
      kind: 'place',
      id: place?.id ?? uid(),
      name: name.trim(),
      emoji: emoji.trim() || undefined,
      category,
      color,
      notes: notes.trim() || undefined,
      createdAt: place?.createdAt ?? now,
      updatedAt: place ? newerStamp(place.updatedAt) : now,
    })
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>{place ? `Edit ${place.name}` : 'Add a place'}</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
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
          <button className="btn primary" disabled={!name.trim()} onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
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
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Went to {place.name}</h2>
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
      </div>
    </div>
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
  return (
    <li className={open ? 'person-row open' : 'person-row'}>
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
              {stats.visits.slice(0, 4).map(v => (
                <li key={v.task.id} onClick={() => onOpenTask(v.task)}>
                  <span>{v.task.title || 'Outing'}</span>
                  <small className="muted">{fmtDate(v.at)}</small>
                </li>
              ))}
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

export function Places({ places, people, tasks, onSave, onDelete, onLogOuting, onPlan, onOpenTask }: Props) {
  const [editing, setEditing] = useState<{ place?: Place } | null>(null)
  const [logging, setLogging] = useState<Place | null>(null)
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [sort, setSort] = useState<SortKey>('recent')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const allStats = useMemo(() => places.map(p => placeStats(p, tasks, people)), [places, tasks, people])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = allStats
      .filter(s => category === 'all' || s.place.category === category)
      .filter(s => !needle || s.place.name.toLowerCase().includes(needle) || (s.place.notes ?? '').toLowerCase().includes(needle))
    const sorted = [...list]
    if (sort === 'az') sorted.sort((a, b) => a.place.name.localeCompare(b.place.name))
    else if (sort === 'za') sorted.sort((a, b) => b.place.name.localeCompare(a.place.name))
    else if (sort === 'most') sorted.sort((a, b) => b.visits.length - a.visits.length)
    else if (sort === 'longest')
      sorted.sort((a, b) => (a.lastAt ?? '').localeCompare(b.lastAt ?? '') || a.place.name.localeCompare(b.place.name))
    else sorted.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.place.name.localeCompare(b.place.name))
    return sorted
  }, [allStats, category, sort, q])

  const year = new Date().getFullYear()
  const outingsThisYear = useMemo(() => {
    const ids = new Set(shown.map(s => s.place.id))
    return tasks.filter(t => t.status === 'done' && t.completedAt && t.placeId && ids.has(t.placeId) && new Date(t.completedAt).getFullYear() === year)
      .length
  }, [shown, tasks, year])

  return (
    <section className="people">
      <div className="toolbar people-toolbar">
        <div>
          <h2 className="view-title">Places</h2>
          <p className="chart-sub">Where you've been, how often, and who you usually go with.</p>
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing({})}>
          + Add place
        </button>
      </div>

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
              <div className="stat-label">Places</div>
              <div className="stat-value">{shown.length}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Outings this year</div>
              <div className="stat-value">{outingsThisYear}</div>
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
