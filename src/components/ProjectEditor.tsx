import { useEffect, useRef, useState } from 'react'
import { BOARD_STATUSES, GithubProjectSync, Milestone, PROJECT_COLORS, PROJECT_STATUSES, PROJECT_STATUS_META, Project, ProjectStatus, STATUS_META, Task, Template, projectProgress } from '../types'
import { BUILT_IN_TEMPLATES, extendProject, templateFromProject } from '../templates'
import { DraftedPlan, draftPlan } from '../ai'
import { newerStamp } from '../itemops'
import { fromLocalInput, toLocalInput, uid } from '../utils'
import { GithubProjectFields, fetchProjectFields, parseGithubUrl } from '../github'
import { defaultColumnMap } from '../githubsync'
import { GithubCard } from './GithubCard'
import { ConfirmButton } from './ConfirmButton'
import { ProgressBar } from './bits'
import { Modal, ModalHead } from './Modal'

interface Props {
  /** The project being edited. Nothing opens the editor on a blank one: there is one ongoing project. */
  project: Project
  tasks: Task[]
  getLatest(id: string): Project | undefined
  onSave(p: Project): void
  onDelete(id: string): void
  onClose(): void
  onOpenNotes?(p: Project): void
  /** Saved templates (built-ins are added automatically). */
  templates?: Template[]
  /** Save the project together with a batch of new tasks in it (from a template or a drafted plan). */
  onCreateMany?(project: Project, tasks: Task[]): void
  onSaveTemplate?(t: Template): void
}

/** The fields this form edits. Everything else on the project — its notepad, the pin, the owner — it never touches. */
type FormFields = Pick<Project, 'name' | 'emoji' | 'color' | 'description' | 'status' | 'startAt' | 'targetAt' | 'milestones' | 'githubUrl' | 'githubProjectSync'>

/**
 * The project as it now stands with the fields this form changed laid over
 * it, under a newer stamp. `current` is the newest copy: another device, or the
 * notepad's Pin, may have changed it since the editor opened. A field the form
 * left alone keeps current's value, and so does everything the form does not
 * hold.
 */
export function withEdits(current: Project, was: FormFields, form: FormFields): Project {
  const next: Project = { ...current }
  for (const key of Object.keys(form) as (keyof FormFields)[]) {
    if (JSON.stringify(form[key]) !== JSON.stringify(was[key])) {
      ;(next as unknown as Record<string, unknown>)[key] = form[key]
    }
  }
  next.updatedAt = newerStamp(current.updatedAt)
  return next
}

const toDateInput = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
const fromDateInput = (v: string) => (v ? fromLocalInput(`${v}T12:00`) : undefined)
/** The day `ahead` days from today as a date input holds it: the local date, not UTC's. */
const dayInput = (ahead = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + ahead)
  return toLocalInput(d.toISOString()).slice(0, 10)
}

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
  // the project as the editor opened on it: the form's edits are measured against this
  const [base] = useState(project)
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
  /** The day a chosen template's tasks are dated from: its "start". */
  const [templateFrom, setTemplateFrom] = useState(() => dayInput())
  const [goal, setGoal] = useState('')
  const [plan, setPlan] = useState<DraftedPlan | null>(null)
  /** The day a drafted plan's tasks are dated from (its day 0): today unless changed. */
  const [planFrom, setPlanFrom] = useState(() => dayInput())
  const [planBusy, setPlanBusy] = useState(false)
  const [planError, setPlanError] = useState('')
  const [savedTemplate, setSavedTemplate] = useState(false)
  const allTemplates = [...templates, ...BUILT_IN_TEMPLATES]
  const chosen = allTemplates.find(t => t.id === templateId)

  const pickTemplate = (id: string) => {
    setTemplateId(id)
    const t = allTemplates.find(x => x.id === id)
    if (!t) return
    // event-anchored templates (a trip, a party) schedule backwards from the
    // day itself, so it opens far enough ahead that the lead-in fits —
    // otherwise every "book it 6 weeks before" task lands overdue on day one.
    // Only the new tasks' day is set: the project keeps its own name, colour
    // and dates.
    const lead = Math.min(0, ...t.tasks.map(x => x.offsetDays ?? 0), ...(t.milestones ?? []).map(m => m.offsetDays))
    setTemplateFrom(dayInput(-lead))
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

  function formValues(): FormFields {
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
  function baseValues(): FormFields {
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
  /** What Save writes, and what a template's or a plan's tasks are added to: the newest copy of the project with this form's edits. */
  const edited = () => withEdits(getLatest(base.id) ?? base, baseValues(), formValues())

  function requestClose() {
    if (isDirty() && !window.confirm('Discard your changes?')) return
    onClose()
  }

  function save() {
    onSave(edited())
  }

  /** Add a template's or the drafted plan's tasks and milestones to the project, dated from `from`, with this form's edits. */
  const createWith = (tpl: Template, from: string) => {
    if (!onCreateMany) return
    const { project: next, tasks: made } = extendProject(edited(), tpl, from ? new Date(`${from}T12:00`) : new Date())
    onCreateMany(next, made)
  }

  const addMilestone = () => {
    const text = newMs.trim()
    if (!text) return
    setMilestones(cur => [...cur, { id: uid(), name: text }])
    setNewMs('')
  }

  return (
    <Modal onClose={requestClose}>
      <ModalHead title="Edit project">
        <button className="btn primary modal-head-save" onClick={save}>
          Save
        </button>
      </ModalHead>

      <div className="modal-body">
        <div className="field-row">
          <label className="field emoji-field">
            <span>Icon</span>
            <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="🏡" maxLength={4} />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Kitchen refresh" />
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
          <>
            <label className="field">
              <span>
                Add tasks from a template <small>(its tasks and milestones join this project)</small>
              </span>
              <select value={templateId} onChange={e => pickTemplate(e.target.value)}>
                <option value="">Choose a template…</option>
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
            </label>
            {chosen && (
              <label className="field">
                <span>Dated from</span>
                <input type="date" value={templateFrom} onChange={e => setTemplateFrom(e.target.value)} />
                <small className="field-hint">
                  {chosen.description ? `${chosen.description} ` : ''}Every task and milestone is dated from this day. The project keeps its own name, colour and dates.
                </small>
              </label>
            )}

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
                  <label className="field">
                    <span>
                      Dated from <small>(the plan’s day 0)</small>
                    </span>
                    <input type="date" value={planFrom} onChange={e => setPlanFrom(e.target.value)} />
                  </label>
                  <div className="ai-row">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => {
                        const tpl = planAsTemplate()
                        if (tpl) createWith(tpl, planFrom)
                      }}
                    >
                      Add these to the project
                    </button>
                    <button type="button" className="btn subtle" onClick={() => setPlan(null)}>
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
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

        {onOpenNotes && (
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
        <div className="field">
          <span>Progress</span>
          <div className="project-progress-row">
            <ProgressBar pct={progress.pct} color={color} />
            <small>
              {progress.done} of {progress.total} tasks done
            </small>
          </div>
        </div>
      </div>

      <footer className="modal-foot">
        <ConfirmButton onConfirm={() => onDelete(project.id)} confirmLabel="Click again to delete project">
          Delete
        </ConfirmButton>
        {onSaveTemplate && (
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
        {chosen && onCreateMany ? (
          <button className="btn primary" onClick={() => createWith(chosen, templateFrom)}>
            Add {chosen.tasks.length} task{chosen.tasks.length === 1 ? '' : 's'}
          </button>
        ) : (
          <button className="btn primary" onClick={save}>
            Save
          </button>
        )}
      </footer>
    </Modal>
  )
}
