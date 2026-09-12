import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { JournalEntry, MOOD_META, PLACE_CATEGORY_META, Person, Place, Project, STATUS_META, Task } from '../types'
import { htmlToText } from '../richtext'
import { relativeDayLabel } from '../journal'
import { excerpt } from '../utils'
import { Icon, type IconName } from './Icon'
import { Modal } from './Modal'

/** A palette command: jump somewhere, or do something. `run` closes the palette
 *  itself (the caller wires the navigation/action). */
export interface Command {
  id: string
  label: string
  hint?: string
  icon?: IconName
  /** whether it shows before you type — the quick actions on an empty palette */
  quick?: boolean
  /** extra words to match on (e.g. "review" for the Week command) */
  keywords?: string
  run(): void
}

interface Props {
  tasks: Task[]
  projects: Project[]
  people: Person[]
  places?: Place[]
  journal?: JournalEntry[]
  commands?: Command[]
  onOpenTask(t: Task): void
  onOpenProject(p: Project): void
  onOpenPerson(p: Person): void
  onOpenPlace?(p: Place): void
  onOpenJournal?(e: JournalEntry): void
  onSaw?(p: Person): void
  /** openEditor=false files the line straight to the Inbox with no editor. */
  onCreateTask(title: string, openEditor?: boolean): void
  onClose(): void
}

type Hit =
  | { kind: 'task'; score: number; task: Task; where: string }
  | { kind: 'project'; score: number; project: Project; where: string }
  | { kind: 'person'; score: number; person: Person; where: string }
  | { kind: 'place'; score: number; place: Place; where: string }
  | { kind: 'journal'; score: number; entry: JournalEntry; where: string }
  | { kind: 'create'; score: number; title: string }
  | { kind: 'recent'; score: number; task: Task }
  | { kind: 'command'; score: number; command: Command }

function score(haystack: string, needle: string, weight: number): number {
  const h = haystack.toLowerCase()
  if (!h) return 0
  const i = h.indexOf(needle)
  if (i === -1) return 0
  // earlier and whole-word matches rank higher
  const wordStart = i === 0 || /\s/.test(h[i - 1])
  return weight * (wordStart ? 2 : 1) + (i === 0 ? weight : 0)
}

const OPEN = new Set(['wishlist', 'todo', 'doing', 'blocked'])

/** Cmd/Ctrl+K palette: jump anywhere, run a command, find anything, or create a
 *  task from what you typed. */
export function Search({ tasks, projects, people, places = [], journal = [], commands = [], onOpenTask, onOpenProject, onOpenPerson, onOpenPlace, onOpenJournal, onSaw, onCreateTask, onClose }: Props) {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  // the results are a listbox the field drives: focus stays in the field, and
  // aria-activedescendant names the row that Enter would open
  const listId = useId()
  const optionId = (i: number) => `${listId}-${i}`
  const projectName = useMemo(() => new Map(projects.map(p => [p.id, p.name])), [projects])

  useEffect(() => {
    input.current?.focus()
  }, [])

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) {
      // empty palette: the quick-action commands, then the 6 most recent open tasks
      const quick: Hit[] = commands.filter(c => c.quick).map(command => ({ kind: 'command' as const, score: 0, command }))
      const recent: Hit[] = [...tasks]
        .filter(t => OPEN.has(t.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 6)
        .map(task => ({ kind: 'recent' as const, score: 0, task }))
      return [...quick, ...recent]
    }
    const out: Hit[] = []
    for (const c of commands) {
      const s = score(c.label, needle, 9) + score(c.keywords ?? '', needle, 6)
      if (s > 0) out.push({ kind: 'command', score: s, command: c })
    }
    for (const t of tasks) {
      const s =
        score(t.title, needle, 10) +
        score(t.description, needle, 4) +
        score(t.tags.join(' '), needle, 6) +
        score((t.comments ?? []).map(c => c.body).join(' '), needle, 3) +
        score((t.checklist ?? []).map(c => c.text).join(' '), needle, 3) +
        score(t.projectId ? projectName.get(t.projectId) ?? '' : '', needle, 2)
      if (s > 0) {
        const where = score(t.title, needle, 1) ? '' : score(t.description, needle, 1) ? excerpt(t.description, 70) : score((t.comments ?? []).map(c => c.body).join(' '), needle, 1) ? 'in comments' : score((t.checklist ?? []).map(c => c.text).join(' '), needle, 1) ? 'in checklist' : ''
        out.push({ kind: 'task', score: s + (t.status === 'done' || t.status === 'canceled' ? -3 : 0), task: t, where })
      }
    }
    for (const p of projects) {
      const notes = p.notesHtml ? htmlToText(p.notesHtml) : (p.notes ?? '')
      const s = score(p.name, needle, 12) + score(p.description ?? '', needle, 4) + score(notes, needle, 3)
      if (s > 0) out.push({ kind: 'project', score: s, project: p, where: score(p.name, needle, 1) ? '' : score(notes, needle, 1) ? 'in notes' : excerpt(p.description ?? '', 70) })
    }
    for (const p of people) {
      const s = score(p.name, needle, 12) + score(p.notes ?? '', needle, 3)
      if (s > 0) out.push({ kind: 'person', score: s, person: p, where: score(p.name, needle, 1) ? '' : 'in notes' })
    }
    for (const p of places) {
      const s = score(p.name, needle, 12) + score(p.notes ?? '', needle, 3)
      if (s > 0) out.push({ kind: 'place', score: s, place: p, where: score(p.name, needle, 1) ? '' : 'in notes' })
    }
    for (const e of journal) {
      const s = score(e.body, needle, 5)
      if (s > 0) {
        const i = e.body.toLowerCase().indexOf(needle)
        out.push({ kind: 'journal', score: s, entry: e, where: excerpt(e.body.slice(Math.max(0, i - 30)), 90) })
      }
    }
    out.sort((a, b) => b.score - a.score)
    const top = out.slice(0, 12)
    const createHit: Hit = { kind: 'create', score: -1, title: q.trim() }
    const exactTaskTitle = tasks.some(t => t.title.trim().toLowerCase() === needle)
    if (exactTaskTitle) top.push(createHit)
    else top.unshift(createHit)
    return top
  }, [q, tasks, projects, people, places, journal, commands, projectName])

  useEffect(() => setCursor(0), [q])

  // a click on the create row opens the editor; only Shift+Enter passes false
  const pick = (h: Hit, openEditor = true) => {
    onClose()
    if (h.kind === 'task' || h.kind === 'recent') onOpenTask(h.task)
    else if (h.kind === 'project') onOpenProject(h.project)
    else if (h.kind === 'person') onOpenPerson(h.person)
    else if (h.kind === 'place') onOpenPlace?.(h.place)
    else if (h.kind === 'journal') onOpenJournal?.(h.entry)
    else if (h.kind === 'command') h.command.run()
    else if (h.kind === 'create' && h.title) onCreateTask(h.title, openEditor)
  }

  return (
    <Modal onClose={onClose} className="search-palette" backdropClassName="modal-backdrop search-backdrop" label="Search">
      <input
        ref={input}
        className="search-input"
        role="combobox"
        aria-label="Search"
        aria-autocomplete="list"
        aria-expanded={hits.length > 0}
        aria-controls={hits.length > 0 ? listId : undefined}
        aria-activedescendant={hits[cursor] ? optionId(cursor) : undefined}
        value={q}
        placeholder="Search or jump to anything — a task, a view, a person… or type to create"
        onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setCursor(c => Math.min(c + 1, Math.max(hits.length - 1, 0)))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setCursor(c => Math.max(c - 1, 0))
          } else if (e.key === 'Enter' && hits[cursor]) {
            const h = hits[cursor]
            // Enter edits, Shift+Enter captures without stopping at the editor
            if (h.kind === 'create' && h.title) pick(h, !e.shiftKey)
            else pick(h)
          }
        }}
      />
      {hits.length === 0 && q.trim() && <p className="empty search-empty">No matches. Keep typing to create “{q.trim()}”.</p>}
      {hits.length === 0 && !q.trim() && (
        <p className="empty search-empty">
          No open tasks yet.{' '}
          <button type="button" className="btn subtle" onClick={() => { onClose(); onCreateTask('', true) }}>
            + New task
          </button>
        </p>
      )}
      {hits.length > 0 && (
        <ul className="search-results" id={listId} role="listbox" aria-label="Results">
          {hits.map((h, i) => {
            const active = i === cursor
            if (h.kind === 'command')
              return (
                <li key={h.command.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active command' : 'search-hit command'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">{h.command.icon ? <Icon name={h.command.icon} size={17} /> : '⌘'}</span>
                  <span className="search-main">
                    {h.command.label}
                    {h.command.hint && <small>{h.command.hint}</small>}
                  </span>
                </li>
              )
            if (h.kind === 'create')
              return (
                <li key="create" id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active create' : 'search-hit create'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">＋</span>
                  <span className="search-main">
                    Create task “{h.title}”<small>Enter to edit · Shift+Enter to capture</small>
                  </span>
                  {/* the touch route to capture: a phone has no Shift key, and a tap
                      on the row itself opens the editor */}
                  <button
                    type="button"
                    className="btn subtle"
                    onClick={e => {
                      e.stopPropagation()
                      pick(h, false)
                    }}
                  >
                    Capture
                  </button>
                </li>
              )
            if (h.kind === 'task' || h.kind === 'recent')
              return (
                <li key={h.task.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">☐</span>
                  <span className="search-main">
                    {h.task.title || 'Untitled'}
                    <small>
                      {h.task.projectId ? projectName.get(h.task.projectId) : 'No project'}
                      {h.kind === 'task' && h.where ? ` · ${h.where}` : ''}
                    </small>
                  </span>
                  <span className="badge" style={{ background: STATUS_META[h.task.status].bg, color: STATUS_META[h.task.status].color }}>
                    {STATUS_META[h.task.status].label}
                  </span>
                </li>
              )
            if (h.kind === 'project')
              return (
                <li key={h.project.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">
                    <span className="pdot" style={{ background: h.project.color }} />
                  </span>
                  <span className="search-main">
                    {h.project.emoji ? `${h.project.emoji} ` : ''}
                    {h.project.name}
                    <small>Project{h.where ? ` · ${h.where}` : ''}</small>
                  </span>
                </li>
              )
            if (h.kind === 'place')
              return (
                <li key={h.place.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">
                    <span className="person-avatar small" style={{ background: h.place.color }}>
                      {h.place.emoji ?? PLACE_CATEGORY_META[h.place.category].emoji}
                    </span>
                  </span>
                  <span className="search-main">
                    {h.place.name}
                    <small>
                      {PLACE_CATEGORY_META[h.place.category].label}
                      {h.where ? ` · ${h.where}` : ''}
                    </small>
                  </span>
                </li>
              )
            if (h.kind === 'journal')
              return (
                <li key={h.entry.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">{h.entry.mood ? MOOD_META[h.entry.mood].emoji : '📓'}</span>
                  <span className="search-main">
                    {relativeDayLabel(h.entry.date)}
                    <small>Journal · {h.where}</small>
                  </span>
                </li>
              )
            return (
              <li key={h.person.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                <span className="search-kind">
                  <span className="person-avatar small" style={{ background: h.person.color }}>
                    {h.person.emoji ?? h.person.name.slice(0, 1)}
                  </span>
                </span>
                <span className="search-main">
                  {h.person.name}
                  <small>Person{h.where ? ` · ${h.where}` : ''}</small>
                </span>
                {onSaw && (
                  <button
                    type="button"
                    className="btn subtle"
                    onClick={e => {
                      e.stopPropagation()
                      onClose()
                      onSaw(h.person)
                    }}
                  >
                    Saw {h.person.name.split(' ')[0]} today
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
