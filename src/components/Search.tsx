import { useEffect, useMemo, useRef, useState } from 'react'
import { Person, Project, STATUS_META, Task } from '../types'
import { htmlToText } from '../richtext'
import { excerpt } from '../utils'

interface Props {
  tasks: Task[]
  projects: Project[]
  people: Person[]
  onOpenTask(t: Task): void
  onOpenProject(p: Project): void
  onOpenPerson(p: Person): void
  onCreateTask(title: string): void
  onClose(): void
}

type Hit =
  | { kind: 'task'; score: number; task: Task; where: string }
  | { kind: 'project'; score: number; project: Project; where: string }
  | { kind: 'person'; score: number; person: Person; where: string }
  | { kind: 'create'; score: number; title: string }

function score(haystack: string, needle: string, weight: number): number {
  const h = haystack.toLowerCase()
  if (!h) return 0
  const i = h.indexOf(needle)
  if (i === -1) return 0
  // earlier and whole-word matches rank higher
  const wordStart = i === 0 || /\s/.test(h[i - 1])
  return weight * (wordStart ? 2 : 1) + (i === 0 ? weight : 0)
}

/** Cmd/Ctrl+K palette: find anything, or create a task from what you typed. */
export function Search({ tasks, projects, people, onOpenTask, onOpenProject, onOpenPerson, onCreateTask, onClose }: Props) {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const projectName = useMemo(() => new Map(projects.map(p => [p.id, p.name])), [projects])

  useEffect(() => {
    input.current?.focus()
  }, [])

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const out: Hit[] = []
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
    out.sort((a, b) => b.score - a.score)
    const top = out.slice(0, 12)
    top.push({ kind: 'create', score: -1, title: q.trim() })
    return top
  }, [q, tasks, projects, people, projectName])

  useEffect(() => setCursor(0), [q])

  const pick = (h: Hit) => {
    onClose()
    if (h.kind === 'task') onOpenTask(h.task)
    else if (h.kind === 'project') onOpenProject(h.project)
    else if (h.kind === 'person') onOpenPerson(h.person)
    else if (h.title) onCreateTask(h.title)
  }

  return (
    <div className="modal-backdrop search-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="search-palette" role="dialog" aria-modal="true" aria-label="Search">
        <input
          ref={input}
          className="search-input"
          value={q}
          placeholder="Search tasks, notes, projects, people… or type a new task and press Enter"
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor(c => Math.min(c + 1, hits.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor(c => Math.max(c - 1, 0))
            } else if (e.key === 'Enter' && hits[cursor]) pick(hits[cursor])
          }}
        />
        {hits.length > 0 && (
          <ul className="search-results">
            {hits.map((h, i) => {
              const active = i === cursor
              if (h.kind === 'create')
                return (
                  <li key="create" className={active ? 'search-hit active create' : 'search-hit create'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                    <span className="search-kind">＋</span>
                    <span className="search-main">
                      Create task “{h.title}”<small>Enter</small>
                    </span>
                  </li>
                )
              if (h.kind === 'task')
                return (
                  <li key={h.task.id} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                    <span className="search-kind">☐</span>
                    <span className="search-main">
                      {h.task.title || 'Untitled'}
                      <small>
                        {h.task.projectId ? projectName.get(h.task.projectId) : 'No project'}
                        {h.where ? ` · ${h.where}` : ''}
                      </small>
                    </span>
                    <span className="badge" style={{ background: STATUS_META[h.task.status].bg, color: STATUS_META[h.task.status].color }}>
                      {STATUS_META[h.task.status].label}
                    </span>
                  </li>
                )
              if (h.kind === 'project')
                return (
                  <li key={h.project.id} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
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
              return (
                <li key={h.person.id} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">
                    <span className="person-avatar small" style={{ background: h.person.color }}>
                      {h.person.emoji ?? h.person.name.slice(0, 1)}
                    </span>
                  </span>
                  <span className="search-main">
                    {h.person.name}
                    <small>Person{h.where ? ` · ${h.where}` : ''}</small>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <div className="search-foot">
          <small>↑↓ to move · Enter to open · Esc to close</small>
        </div>
      </div>
    </div>
  )
}
