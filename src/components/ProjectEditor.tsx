import { useState } from 'react'
import { Milestone, PROJECT_COLORS, PROJECT_STATUSES, PROJECT_STATUS_META, Project, ProjectStatus, Task, projectProgress } from '../types'
import { newerStamp } from '../itemops'
import { fromLocalInput, uid } from '../utils'
import { GithubCard } from './GithubCard'
import { ConfirmButton } from './ConfirmButton'
import { ProgressBar } from './bits'

interface Props {
  project?: Project
  tasks: Task[]
  getLatest(id: string): Project | undefined
  onSave(p: Project): void
  onDelete(id: string): void
  onClose(): void
  onOpenNotes?(p: Project): void
}

const toDateInput = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
const fromDateInput = (v: string) => (v ? fromLocalInput(`${v}T12:00`) : undefined)

export function ProjectEditor({ project, tasks, getLatest, onSave, onDelete, onClose, onOpenNotes }: Props) {
  const [base] = useState<Project>(() => {
    const now = new Date().toISOString()
    return (
      project ?? {
        kind: 'project',
        id: uid(),
        name: '',
        color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
    )
  })
  const [name, setName] = useState(base.name)
  const [emoji, setEmoji] = useState(base.emoji ?? '')
  const [color, setColor] = useState(base.color)
  const [description, setDescription] = useState(base.description ?? '')
  const [status, setStatus] = useState<ProjectStatus>(base.status)
  const [startAt, setStartAt] = useState(toDateInput(base.startAt))
  const [targetAt, setTargetAt] = useState(toDateInput(base.targetAt))
  const [milestones, setMilestones] = useState<Milestone[]>(base.milestones ?? [])
  const [githubUrl, setGithubUrl] = useState(base.githubUrl ?? '')
  const [newMs, setNewMs] = useState('')

  const progress = projectProgress(tasks)

  function formValues() {
    return {
      name: name.trim() || 'Untitled project',
      emoji: emoji.trim() || undefined,
      color,
      description: description.trim() || undefined,
      status,
      startAt: fromDateInput(startAt),
      targetAt: fromDateInput(targetAt),
      milestones: milestones.length > 0 ? milestones : undefined,
      githubUrl: githubUrl.trim() || undefined,
    }
  }
  function baseValues() {
    return {
      name: base.name,
      emoji: base.emoji,
      color: base.color,
      description: base.description,
      status: base.status,
      startAt: base.startAt,
      targetAt: base.targetAt,
      milestones: base.milestones,
      githubUrl: base.githubUrl,
    }
  }
  const isDirty = () => JSON.stringify(formValues()) !== JSON.stringify(baseValues())

  function requestClose() {
    if (isDirty() && !window.confirm('Discard your changes?')) return
    onClose()
  }

  function save() {
    const current = getLatest(base.id) ?? base
    const form = formValues()
    const was = baseValues()
    const next: Project = { ...current }
    for (const key of Object.keys(form) as (keyof typeof form)[]) {
      if (JSON.stringify(form[key]) !== JSON.stringify(was[key])) {
        ;(next as unknown as Record<string, unknown>)[key] = form[key]
      }
    }
    next.updatedAt = newerStamp(current.updatedAt)
    onSave(next)
  }

  const addMilestone = () => {
    const text = newMs.trim()
    if (!text) return
    setMilestones(cur => [...cur, { id: uid(), name: text }])
    setNewMs('')
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>{project ? 'Edit project' : 'New project'}</h2>
          <button className="btn primary modal-head-save" onClick={save}>
            Save
          </button>
          <button className="btn subtle" onClick={requestClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="field-row">
            <label className="field emoji-field">
              <span>Icon</span>
              <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="🏡" maxLength={4} />
            </label>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Kitchen refresh" autoFocus={!project} />
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
            <span>Description</span>
            <textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="What does done look like?" />
          </label>

          <div className="field">
            <span>Status</span>
            <div className="segmented">
              {PROJECT_STATUSES.map(s => (
                <button key={s} type="button" className={status === s ? 'seg on' : 'seg'} onClick={() => setStatus(s)}>
                  {PROJECT_STATUS_META[s].label}
                </button>
              ))}
            </div>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Start</span>
              <input type="date" value={startAt} onChange={e => setStartAt(e.target.value)} />
            </label>
            <label className="field">
              <span>Target</span>
              <input type="date" value={targetAt} onChange={e => setTargetAt(e.target.value)} />
            </label>
          </div>

          <div className="field">
            <span>
              Milestones <small>(show as ◆ on the roadmap)</small>
            </span>
            <ul className="checklist">
              {milestones.map(m => (
                <li key={m.id} className="check-item">
                  <input type="checkbox" checked={!!m.done} onChange={e => setMilestones(cur => cur.map(x => (x.id === m.id ? { ...x, done: e.target.checked || undefined } : x)))} aria-label="Reached" />
                  <input className="check-text" value={m.name} onChange={e => setMilestones(cur => cur.map(x => (x.id === m.id ? { ...x, name: e.target.value } : x)))} />
                  <input type="date" value={toDateInput(m.dueAt)} onChange={e => setMilestones(cur => cur.map(x => (x.id === m.id ? { ...x, dueAt: fromDateInput(e.target.value) } : x)))} aria-label="Milestone date" />
                  <button type="button" className="btn subtle" aria-label="Remove" onClick={() => setMilestones(cur => cur.filter(x => x.id !== m.id))}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <div className="check-add">
              <input
                value={newMs}
                onChange={e => setNewMs(e.target.value)}
                placeholder="Add a milestone and press Enter"
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addMilestone()
                  }
                }}
              />
              <button type="button" className="btn" onClick={addMilestone}>
                Add
              </button>
            </div>
          </div>

          <label className="field">
            <span>
              GitHub <small>(repo or Projects board URL)</small>
            </span>
            <input value={githubUrl} onChange={e => setGithubUrl(e.target.value)} placeholder="https://github.com/you/repo or …/users/you/projects/1" />
          </label>
          {githubUrl.trim() && <GithubCard url={githubUrl.trim()} />}

          {project && onOpenNotes && (
            <div className="field">
              <span>Notes</span>
              <button
                type="button"
                className="btn notes-open"
                onClick={() => {
                  if (isDirty()) save()
                  else onClose()
                  onOpenNotes(getLatest(project.id) ?? project)
                }}
              >
                Open the notepad{project.notes ? ` (${project.notes.split(/\s+/).filter(Boolean).length} words)` : ''}
              </button>
              <small className="field-hint">A running notepad with formatting, checklists, links, code, emoji and inline photos. Autosaves.</small>
            </div>
          )}
          {project && (
            <div className="field">
              <span>Progress</span>
              <div className="project-progress-row">
                <ProgressBar pct={progress.pct} color={color} />
                <small>
                  {progress.done} of {progress.total} tasks done
                </small>
              </div>
            </div>
          )}
        </div>

        <footer className="modal-foot">
          {project && (
            <ConfirmButton onConfirm={() => onDelete(project.id)} confirmLabel="Click again to delete project">
              Delete
            </ConfirmButton>
          )}
          <span className="spacer" />
          <button className="btn" onClick={requestClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}
