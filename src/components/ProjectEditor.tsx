import { useEffect, useRef, useState } from 'react'
import { BOARD_STATUSES, GithubProjectSync, Milestone, PROJECT_COLORS, PROJECT_STATUSES, PROJECT_STATUS_META, Project, ProjectStatus, STATUS_META, Task, Template, projectProgress } from '../types'
import { BUILT_IN_TEMPLATES, instantiateTemplate, templateFromProject } from '../templates'
import { DraftedPlan, draftPlan } from '../ai'
import { newerStamp } from '../itemops'
import { fromLocalInput, uid } from '../utils'
import { GithubProjectFields, fetchProjectFields, parseGithubUrl } from '../github'
import { defaultColumnMap } from '../githubsync'
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
  /** Saved templates (built-ins are added automatically). */
  templates?: Template[]
  /** Create a project together with its tasks (from a template or an AI plan). */
  onCreateMany?(project: Project, tasks: Task[]): void
  onSaveTemplate?(t: Template): void
}

const toDateInput = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
const fromDateInput = (v: string) => (v ? fromLocalInput(`${v}T12:00`) : undefined)

/**
 * Two-way GitHub Projects sync, offered only when the GitHub field holds a
 * Projects board URL. Turning it on asks the host for the board's fields; a
 * host whose token cannot read Projects answers 501 and the message is shown
 * as it came, because "set the `project` scope" is the only useful next step.
 */
function ProjectSyncFields({ url, sync, onChange }: { url: string; sync?: GithubProjectSync; onChange(next: GithubProjectSync | undefined): void }) {
  const [fields, setFields] = useState<GithubProjectFields | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const on = !!sync
  const syncRef = useRef(sync)
  syncRef.current = sync
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // the URL is a live input: read the board once typing settles, not once per
  // keystroke — every read is a session-gated POST and a GraphQL round trip
  const [settled, setSettled] = useState(url)

  useEffect(() => {
    const t = window.setTimeout(() => setSettled(url), 400)
    return () => window.clearTimeout(t)
  }, [url])

  useEffect(() => {
    if (!on) {
      setFields(null)
      setError('')
      return
    }
    let cancelled = false
    setBusy(true)
    setError('')
    fetchProjectFields(settled)
      .then(f => {
        if (cancelled) return
        setFields(f)
        const cur = syncRef.current
        // first read of a board: propose the mapping instead of an empty form
        if (f.statusField && !cur?.statusFieldId) {
          onChangeRef.current({ ...cur, statusFieldId: f.statusField.id, columns: { ...defaultColumnMap(f.statusField.options), ...cur?.columns } })
        }
      })
      .catch(e => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [on, settled])

  const selected = fields?.selectFields.find(f => f.id === sync?.statusFieldId) ?? fields?.statusField
  const options = selected?.options ?? []

  return (
    <div className="field">
      <label className="cal-source mirror-row">
        <input
          type="checkbox"
          checked={on}
          onChange={e => onChange(e.target.checked ? (syncRef.current ?? {}) : undefined)}
        />
        <span>
          Sync status and due dates <small>(moving a card here moves it there, and back on the next check)</small>
        </span>
      </label>
      {on && busy && <small className="field-hint">Reading the board…</small>}
      {on && error && <p className="field-hint warn">{error}</p>}
      {on && fields && !error && (
        <>
          {fields.selectFields.length === 0 ? (
            <p className="field-hint warn">This board has no single-select field, so there is no column to map a status onto.</p>
          ) : (
            <label className="field">
              <span>Status field on the board</span>
              <select
                value={selected?.id ?? ''}
                onChange={e => {
                  const next = fields.selectFields.find(f => f.id === e.target.value)
                  onChange({ ...sync, statusFieldId: next?.id, columns: next ? defaultColumnMap(next.options) : undefined })
                }}
              >
                {fields.selectFields.map(f => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {options.length > 0 && (
            <div className="gh-map">
              {BOARD_STATUSES.map(s => (
                <label key={s} className="gh-map-row">
                  <span className="badge" style={{ background: STATUS_META[s].bg, color: STATUS_META[s].color }}>
                    {STATUS_META[s].label}
                  </span>
                  <select
                    value={sync?.columns?.[s] ?? ''}
                    onChange={e => {
                      const columns = { ...sync?.columns }
                      if (e.target.value) columns[s] = e.target.value
                      else delete columns[s]
                      onChange({ ...sync, columns })
                    }}
                    aria-label={`Board column for ${STATUS_META[s].label}`}
                  >
                    <option value="">— not synced —</option>
                    {options.map(o => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <label className="field">
            <span>Write due dates into</span>
            <select value={sync?.dateFieldId ?? ''} onChange={e => onChange({ ...sync, dateFieldId: e.target.value || undefined })}>
              <option value="">Don’t sync dates</option>
              {fields.dateFields.map(f => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {fields.dateFields.length === 0 && <small className="field-hint">This board has no date field yet — add one on GitHub to sync due dates.</small>}
          </label>
        </>
      )}
    </div>
  )
}

export function ProjectEditor({ project, tasks, getLatest, onSave, onDelete, onClose, onOpenNotes, templates = [], onCreateMany, onSaveTemplate }: Props) {
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
  const [projectSync, setProjectSync] = useState<GithubProjectSync | undefined>(base.githubProjectSync)
  /** The board the current mapping belongs to, so only a move to another one drops it. */
  const [syncBoard, setSyncBoard] = useState(() => parseGithubUrl(base.githubUrl))
  const [newMs, setNewMs] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [goal, setGoal] = useState('')
  const [plan, setPlan] = useState<DraftedPlan | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planError, setPlanError] = useState('')
  const [savedTemplate, setSavedTemplate] = useState(false)
  const allTemplates = [...templates, ...BUILT_IN_TEMPLATES]
  const chosen = allTemplates.find(t => t.id === templateId)

  const pickTemplate = (id: string) => {
    setTemplateId(id)
    const t = allTemplates.find(x => x.id === id)
    if (!t) return
    if (!name.trim()) setName(t.name)
    if (!emoji) setEmoji(t.emoji ?? '')
    setColor(t.color)
    if (!description) setDescription(t.description ?? '')
    if (!startAt) {
      // event-anchored templates (a trip, a party) schedule backwards from the
      // start, so default it far enough ahead that the lead-in fits — otherwise
      // every "book it 6 weeks before" task lands overdue on day one
      const lead = Math.min(0, ...t.tasks.map(x => x.offsetDays ?? 0), ...(t.milestones ?? []).map(m => m.offsetDays))
      const d = new Date()
      d.setDate(d.getDate() - lead)
      setStartAt(toDateInput(d.toISOString()))
    }
  }

  const runDraft = async () => {
    setPlanBusy(true)
    setPlanError('')
    try {
      setPlan(await draftPlan(goal.trim(), name.trim(), description.trim() || undefined))
    } catch (e) {
      setPlanError((e as Error).message)
    } finally {
      setPlanBusy(false)
    }
  }

  /** Create (or extend) the project with a template's or the AI plan's tasks. */
  const createWith = (tpl: Template) => {
    if (!onCreateMany) return
    const start = startAt ? new Date(`${startAt}T12:00`) : new Date()
    const { project: p, tasks: ts } = instantiateTemplate(tpl, start, {
      id: base.id,
      name: name.trim() || tpl.name,
      emoji: emoji.trim() || tpl.emoji,
      color,
      description: description.trim() || tpl.description,
      status,
      githubUrl: githubUrl.trim() || undefined,
      githubProjectSync: projectSync,
      milestones: [...milestones, ...(tpl.milestones ?? []).map(m => ({ id: uid(), name: m.name, dueAt: fromLocalInput(`${toDateInput(new Date(start.getFullYear(), start.getMonth(), start.getDate() + m.offsetDays, 12).toISOString())}T12:00`) }))],
      createdAt: base.createdAt,
    })
    if (project) {
      // existing project: keep its dates unless empty
      p.startAt = base.startAt ?? p.startAt
      p.targetAt = base.targetAt ?? p.targetAt
      p.notesHtml = base.notesHtml ?? p.notesHtml
      p.updatedAt = newerStamp(base.updatedAt)
    }
    onCreateMany(p, ts)
  }

  const planAsTemplate = (): Template | null =>
    plan
      ? {
          kind: 'template',
          id: 'ai-plan',
          name: name.trim() || 'Plan',
          color,
          durationDays: plan.durationDays,
          tasks: plan.tasks,
          milestones: plan.milestones,
          createdAt: base.createdAt,
          updatedAt: base.createdAt,
        }
      : null

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
      githubProjectSync: projectSync,
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
      githubProjectSync: base.githubProjectSync,
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
          {!project && onCreateMany && (
            <label className="field">
              <span>
                Start from a template <small>(optional — tasks and milestones come with it)</small>
              </span>
              <select value={templateId} onChange={e => pickTemplate(e.target.value)}>
                <option value="">Blank project</option>
                {templates.length > 0 && (
                  <optgroup label="Your templates">
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.emoji ? `${t.emoji} ` : ''}
                        {t.name} · {t.tasks.length} tasks
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Built in">
                  {BUILT_IN_TEMPLATES.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.emoji ? `${t.emoji} ` : ''}
                      {t.name} · {t.tasks.length} tasks
                    </option>
                  ))}
                </optgroup>
              </select>
              {chosen && (
                <small className="field-hint">
                  {chosen.description} The <strong>Start</strong> date below anchors every task.
                </small>
              )}
            </label>
          )}
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

          {onCreateMany && (
            <div className="field ai-plan">
              <span>
                ✨ Draft a plan from a goal <small>(the model proposes dated tasks and milestones; you choose)</small>
              </span>
              <div className="check-add">
                <input value={goal} onChange={e => setGoal(e.target.value)} placeholder="e.g. Turn the spare room into a home office by the end of November" />
                <button type="button" className="btn" disabled={!goal.trim() || planBusy} onClick={runDraft}>
                  {planBusy ? 'Drafting…' : 'Draft'}
                </button>
              </div>
              {planError && <p className="warn">{planError}</p>}
              {plan && (
                <div className="ai-proposal">
                  <div className="ai-proposal-head">
                    <strong>
                      {plan.tasks.length} tasks · {plan.milestones.length} milestones · about {plan.durationDays} days
                    </strong>
                    <small>Anchored on the Start date {startAt ? `(${startAt})` : '(today)'}</small>
                  </div>
                  <ul className="plan-list">
                    {plan.milestones.map(m => (
                      <li key={`m-${m.name}`} className="plan-ms">
                        ◆ {m.name} <small>day {m.offsetDays}</small>
                      </li>
                    ))}
                    {plan.tasks.map((t, i) => (
                      <li key={i}>
                        {t.title} <small>day {t.offsetDays}{t.priority && t.priority !== 'normal' ? ` · ${t.priority}` : ''}{t.checklist?.length ? ` · ${t.checklist.length} steps` : ''}</small>
                      </li>
                    ))}
                  </ul>
                  <div className="ai-row">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => {
                        const tpl = planAsTemplate()
                        if (tpl) createWith(tpl)
                      }}
                    >
                      {project ? 'Add these to the project' : 'Create project with this plan'}
                    </button>
                    <button type="button" className="btn subtle" onClick={() => setPlan(null)}>
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <label className="field">
            <span>
              GitHub <small>(repo or Projects board URL)</small>
            </span>
            <input
              value={githubUrl}
              onChange={e => setGithubUrl(e.target.value)}
              onBlur={e => {
                // a mapping belongs to one board: pointing elsewhere drops it,
                // but only once editing has settled — fixing a typo passes
                // through half-URLs that parse as something else, and losing
                // the mapping mid-keystroke means reading and approving it again
                const ref = parseGithubUrl(e.target.value.trim())
                const moved = syncBoard?.type === 'project' && (ref?.owner !== syncBoard.owner || ref?.number !== syncBoard.number)
                if (ref?.type !== 'project' || moved) setProjectSync(undefined)
                setSyncBoard(ref)
              }}
              placeholder="https://github.com/you/repo or …/users/you/projects/1"
            />
          </label>
          {githubUrl.trim() && <GithubCard url={githubUrl.trim()} />}
          {/*
            Offered for any Projects URL, not only when the card reports a
            writable host: `canWrite` only says a token exists, and a token
            without the `project` scope reads boards and still cannot move a
            card. Ticking the toggle reads the board's fields, so the server's
            own 501 says exactly what is missing where the setting is made.
          */}
          {parseGithubUrl(githubUrl.trim())?.type === 'project' && <ProjectSyncFields url={githubUrl.trim()} sync={projectSync} onChange={setProjectSync} />}

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
          {project && onSaveTemplate && (
            <button
              className="btn subtle"
              title="Save this project's tasks and milestones as a reusable template"
              onClick={() => {
                onSaveTemplate(templateFromProject(getLatest(project.id) ?? project, tasks))
                setSavedTemplate(true)
              }}
            >
              {savedTemplate ? 'Saved as template ✓' : 'Save as template'}
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={requestClose}>
            Cancel
          </button>
          {!project && chosen && onCreateMany ? (
            <button className="btn primary" onClick={() => createWith(chosen)}>
              Create with {chosen.tasks.length} tasks
            </button>
          ) : (
            <button className="btn primary" onClick={save}>
              Save
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
