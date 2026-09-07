import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Attachment,
  ChecklistItem,
  Comment,
  Metrics,
  PLATFORMS,
  Person,
  PLATFORM_META,
  PRIORITIES,
  PRIORITY_META,
  Platform,
  Priority,
  Project,
  RECURRENCE_META,
  RecurrenceFreq,
  SOCIAL_PROJECT_ID,
  STATUS_META,
  TASK_STATUSES,
  Task,
  TaskStatus,
} from '../types'
import { newerStamp } from '../itemops'
import { fmtDateTime, fromLocalInput, toLocalInput, uid } from '../utils'
import { mediaURL, saveMedia } from '../media'
import { REFINE_META, RefineMode, generateVariants, refineDescription, suggestChecklist, suggestTags } from '../ai'
import { GithubCard } from './GithubCard'
import { createIssue, parseGithubUrl } from '../github'
import { ConfirmButton } from './ConfirmButton'

interface Props {
  task?: Task
  preset?: Partial<Task>
  projects: Project[]
  people: Person[]
  /** Household members (empty when not in a household). */
  members: { id: string; displayName: string }[]
  /** Open tasks that could block this one (same project preferred). */
  candidates: Task[]
  /** The freshest copy in the store — save() merges onto it so fields the user
   *  did NOT touch keep concurrent edits (e.g. a bot adding a comment). */
  getLatest(id: string): Task | undefined
  onSave(t: Task): void
  /** Persist without closing (comments and checklist ticks land immediately). */
  onCommit(t: Task): void
  onDelete(id: string): void
  onClose(): void
}

const METRIC_FIELDS: (keyof Metrics)[] = ['likes', 'comments', 'shares', 'impressions']

type Metric = NonNullable<NonNullable<Task['social']>['metrics']>
type Variants = NonNullable<NonNullable<Task['social']>['variants']>

export function TaskEditor({ task, preset, projects, people, members, candidates, getLatest, onSave, onCommit, onDelete, onClose }: Props) {
  const persisted = !!task
  const [base] = useState<Task>(() => {
    const now = new Date().toISOString()
    return (
      task ?? {
        kind: 'task',
        id: uid(),
        title: '',
        description: '',
        status: 'todo',
        priority: 'normal',
        createdAt: now,
        updatedAt: now,
        tags: [],
        ...preset,
      }
    )
  })

  const [title, setTitle] = useState(base.title)
  const [description, setDescription] = useState(base.description)
  const [projectId, setProjectId] = useState(base.projectId ?? '')
  const [status, setStatus] = useState<TaskStatus>(base.status)
  const [priority, setPriority] = useState<Priority>(base.priority)
  const [dueAt, setDueAt] = useState(toLocalInput(base.dueAt))
  const [completedAt, setCompletedAt] = useState(toLocalInput(base.completedAt))
  const [tags, setTags] = useState(base.tags.join(', '))
  const [notes, setNotes] = useState(base.notes ?? '')
  const [link, setLink] = useState(base.link ?? '')
  const [githubUrl, setGithubUrl] = useState(base.githubUrl ?? '')
  const [checklist, setChecklist] = useState<ChecklistItem[]>(base.checklist ?? [])
  const [newCheck, setNewCheck] = useState('')
  const [comments, setComments] = useState<Comment[]>(base.comments ?? [])
  const [newComment, setNewComment] = useState('')
  const [freq, setFreq] = useState<RecurrenceFreq | ''>(base.recurrence?.freq ?? '')
  const [mediaIds, setMediaIds] = useState<string[]>(base.mediaIds ?? [])
  const [peopleIds, setPeopleIds] = useState<string[]>(base.peopleIds ?? [])
  const [peopleQuery, setPeopleQuery] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>(base.attachments ?? [])
  const [estimateCost, setEstimateCost] = useState(base.estimateCost !== undefined ? String(base.estimateCost) : '')
  const [actualCost, setActualCost] = useState(base.actualCost !== undefined ? String(base.actualCost) : '')
  const [blockedBy, setBlockedBy] = useState<string[]>(base.blockedBy ?? [])
  const [assigneeId, setAssigneeId] = useState(base.assigneeId ?? '')
  const fileInput = useRef<HTMLInputElement>(null)

  async function addFiles(files: FileList | null) {
    if (!files) return
    const added: Attachment[] = []
    for (const file of Array.from(files)) {
      const id = await saveMedia(file)
      added.push({ id, name: file.name, type: file.type || 'application/octet-stream', size: file.size })
    }
    if (added.length > 0) setAttachments(cur => [...cur, ...added])
  }

  async function openAttachment(a: Attachment) {
    const url = await mediaURL(a.id)
    if (!url) return setAiError('That file is not available offline yet.')
    const link = document.createElement('a')
    link.href = url
    link.download = a.name
    link.target = '_blank'
    link.click()
  }

  const money = (v: string) => {
    const n = Number(v.replace(/[,\s£$€]/g, ''))
    return v.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined
  }
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [isSocial, setIsSocial] = useState(!!base.social)
  const [platforms, setPlatforms] = useState<Platform[]>(base.social?.platforms?.length ? base.social.platforms : ['x'])
  const [variants, setVariants] = useState<Variants>(base.social?.variants ?? {})
  const [metrics, setMetrics] = useState<Metric>(base.social?.metrics ?? {})
  const [aiBusy, setAiBusy] = useState<'variants' | 'tags' | 'checklist' | RefineMode | null>(null)
  const [aiError, setAiError] = useState('')
  /** A proposed rewrite of the description, waiting for the user to accept or discard it. */
  const [proposal, setProposal] = useState<{ mode: RefineMode; text: string } | null>(null)
  const mediaInput = useRef<HTMLInputElement>(null)
  const finePointer = useMemo(() => window.matchMedia('(pointer: fine)').matches, [])

  useEffect(() => {
    let live = true
    ;(async () => {
      const map: Record<string, string> = {}
      for (const id of mediaIds) {
        const url = await mediaURL(id)
        if (url) map[id] = url
      }
      if (live) setThumbs(map)
    })()
    return () => {
      live = false
    }
  }, [mediaIds])

  const togglePlatform = (pl: Platform) => setPlatforms(cur => (cur.includes(pl) ? cur.filter(x => x !== pl) : [...cur, pl]))
  const setMetric = (pl: Platform, field: keyof Metrics, value: string) =>
    setMetrics(cur => ({ ...cur, [pl]: { ...cur[pl], [field]: value === '' ? undefined : Number(value) } }))
  const effectiveLength = (pl: Platform) => {
    const v = variants[pl]
    return v && v.trim() ? v.length : description.length
  }

  const enableSocial = () => {
    setIsSocial(true)
    if (!projectId && projects.some(p => p.id === SOCIAL_PROJECT_ID)) setProjectId(SOCIAL_PROJECT_ID)
  }

  async function addMedia(files: FileList | null) {
    if (!files) return
    const ids: string[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      ids.push(await saveMedia(file))
    }
    if (ids.length > 0) setMediaIds(cur => [...cur, ...ids])
  }

  async function runAI(kind: 'variants' | 'tags' | 'checklist' | RefineMode) {
    setAiError('')
    setAiBusy(kind)
    try {
      if (kind === 'clarify' || kind === 'expand' || kind === 'summarize') {
        const text = await refineDescription(kind, title, description)
        setProposal({ mode: kind, text })
      } else if (kind === 'variants') {
        const generated = await generateVariants(description, platforms)
        setVariants(cur => ({ ...cur, ...generated }))
      } else if (kind === 'tags') {
        const suggested = await suggestTags(description || title)
        const existing = tags
          .split(',')
          .map(t => t.trim().replace(/^#/, ''))
          .filter(Boolean)
        setTags([...existing, ...suggested.filter(t => !existing.includes(t))].join(', '))
      } else {
        const steps = await suggestChecklist(title, description)
        setChecklist(cur => [...cur, ...steps.map(text => ({ id: uid(), text, done: false }))])
      }
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAiBusy(null)
    }
  }

  /** The form's current value for every editable field, in Task shape. */
  function formValues() {
    const cleanVariants: Variants = {}
    for (const pl of platforms) {
      const v = variants[pl]
      if (v && v.trim()) cleanVariants[pl] = v
    }
    const social: Task['social'] = isSocial
      ? {
          platforms,
          variants: Object.keys(cleanVariants).length > 0 ? cleanVariants : undefined,
          metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
        }
      : undefined
    return {
      title: title.trim(),
      description,
      projectId: projectId || undefined,
      status,
      priority,
      dueAt: fromLocalInput(dueAt),
      completedAt: fromLocalInput(completedAt),
      tags: tags
        .split(',')
        .map(t => t.trim().replace(/^#/, ''))
        .filter(Boolean),
      notes: notes.trim() || undefined,
      link: link.trim() || undefined,
      githubUrl: githubUrl.trim() || undefined,
      checklist: checklist.length > 0 ? checklist.map(c => ({ ...c, text: c.text.trim() })).filter(c => c.text) : undefined,
      // comments on a persisted task are committed as they're written
      comments: persisted ? base.comments : comments.length > 0 ? comments : undefined,
      mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
      recurrence: freq ? ({ freq } as Task['recurrence']) : undefined,
      social,
      peopleIds: peopleIds.length > 0 ? peopleIds : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      estimateCost: money(estimateCost),
      actualCost: money(actualCost),
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
      assigneeId: assigneeId || undefined,
    }
  }

  function baseValues() {
    return {
      title: base.title,
      description: base.description,
      projectId: base.projectId,
      status: base.status,
      priority: base.priority,
      dueAt: base.dueAt,
      completedAt: base.completedAt,
      tags: base.tags,
      notes: base.notes,
      link: base.link,
      githubUrl: base.githubUrl,
      checklist: base.checklist,
      comments: base.comments,
      mediaIds: base.mediaIds,
      recurrence: base.recurrence,
      social: base.social,
      peopleIds: base.peopleIds,
      attachments: base.attachments,
      estimateCost: base.estimateCost,
      actualCost: base.actualCost,
      blockedBy: base.blockedBy,
      assigneeId: base.assigneeId,
    }
  }

  const isDirty = () => JSON.stringify(formValues()) !== JSON.stringify(baseValues())

  function requestClose() {
    if (isDirty() && !window.confirm('Discard your changes?')) return
    onClose()
  }

  function merged(): Task {
    // merge only the fields the user changed onto the FRESHEST copy, so
    // concurrent updates (a bot logging metrics, an edit on another device)
    // survive an open editor
    const current = getLatest(base.id) ?? base
    const form = formValues()
    const was = baseValues()
    const next: Task = { ...current }
    for (const key of Object.keys(form) as (keyof typeof form)[]) {
      if (JSON.stringify(form[key]) !== JSON.stringify(was[key])) {
        ;(next as unknown as Record<string, unknown>)[key] = form[key]
      }
    }
    if (next.status === 'done') next.completedAt = next.completedAt ?? new Date().toISOString()
    else next.completedAt = undefined
    next.updatedAt = newerStamp(current.updatedAt)
    return next
  }

  /** A task with nothing in it is almost always an accidental open-and-close. */
  function isEmpty(t: Task): boolean {
    return (
      !t.title.trim() &&
      !t.description.trim() &&
      !(t.checklist?.length) &&
      !(t.comments?.length) &&
      !(t.peopleIds?.length) &&
      !(t.attachments?.length) &&
      !(t.mediaIds?.length) &&
      !t.link &&
      !t.githubUrl &&
      !t.notes?.trim()
    )
  }

  function save() {
    const next = merged()
    if (!task && isEmpty(next)) {
      // brand-new and blank: discard rather than litter the list with "Untitled"
      onClose()
      return
    }
    onSave(next)
  }

  function addComment() {
    const body = newComment.trim()
    if (!body) return
    const c: Comment = { id: uid(), body, createdAt: new Date().toISOString() }
    setComments(cur => [...cur, c])
    setNewComment('')
    if (persisted) {
      const current = getLatest(base.id) ?? base
      onCommit({ ...current, comments: [...(current.comments ?? []), c], updatedAt: newerStamp(current.updatedAt) })
    }
  }

  function removeComment(id: string) {
    setComments(cur => cur.filter(c => c.id !== id))
    if (persisted) {
      const current = getLatest(base.id) ?? base
      const rest = (current.comments ?? []).filter(c => c.id !== id)
      onCommit({ ...current, comments: rest.length > 0 ? rest : undefined, updatedAt: newerStamp(current.updatedAt) })
    }
  }

  const addCheck = () => {
    const text = newCheck.trim()
    if (!text) return
    setChecklist(cur => [...cur, { id: uid(), text, done: false }])
    setNewCheck('')
  }

  const overLimit = isSocial ? platforms.filter(pl => effectiveLength(pl) > PLATFORM_META[pl].charLimit) : []
  const checkDone = checklist.filter(c => c.done).length
  const project = projects.find(p => p.id === projectId)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div className="modal wide" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>{task ? 'Edit task' : 'New task'}</h2>
          <button className="btn primary modal-head-save" onClick={save}>
            Save
          </button>
          <button className="btn subtle" onClick={requestClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body editor-grid">
          <div className="editor-main">
            <label className="field">
              <span>Title</span>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Book the electrician" autoFocus={!task && finePointer} />
            </label>

            <label className="field">
              <span>Description</span>
              <textarea rows={5} value={description} onChange={e => setDescription(e.target.value)} placeholder={isSocial ? 'Write the post…' : 'What needs to happen, and why? Links, measurements, context…'} />
              <div className="ai-row desc-ai">
                {(Object.keys(REFINE_META) as RefineMode[]).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    className="btn subtle"
                    title={REFINE_META[mode].hint}
                    disabled={!description.trim() || aiBusy !== null}
                    onClick={e => {
                      e.preventDefault()
                      runAI(mode)
                    }}
                  >
                    {aiBusy === mode ? REFINE_META[mode].busy : REFINE_META[mode].label}
                  </button>
                ))}
              </div>
              {proposal && (
                <div className="ai-proposal" onClick={e => e.preventDefault()}>
                  <div className="ai-proposal-head">
                    <strong>{REFINE_META[proposal.mode].label.replace('✨ ', '')} suggestion</strong>
                    <small>Review, then replace or keep yours</small>
                  </div>
                  <textarea rows={Math.min(12, Math.max(4, proposal.text.split('\n').length + 1))} value={proposal.text} onChange={e => setProposal({ ...proposal, text: e.target.value })} />
                  <div className="ai-row">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => {
                        setDescription(proposal.text)
                        setProposal(null)
                      }}
                    >
                      Replace description
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setDescription(cur => (cur.trim() ? `${cur.trimEnd()}\n\n${proposal.text}` : proposal.text))
                        setProposal(null)
                      }}
                    >
                      Append below
                    </button>
                    <button type="button" className="btn subtle" onClick={() => setProposal(null)}>
                      Discard
                    </button>
                  </div>
                </div>
              )}
              {isSocial && (
                <div className="char-counts">
                  <span className="char-total">{description.length} characters</span>
                  {platforms.map(pl => {
                    const left = PLATFORM_META[pl].charLimit - effectiveLength(pl)
                    return (
                      <span key={pl} className={left < 0 ? 'char-chip over' : 'char-chip'}>
                        {PLATFORM_META[pl].short}: {left < 0 ? `${-left} over` : `${left} left`}
                      </span>
                    )
                  })}
                </div>
              )}
            </label>

            <div className="field">
              <span>
                Checklist {checklist.length > 0 && <small>({checkDone}/{checklist.length} done)</small>}
              </span>
              <ul className="checklist">
                {checklist.map(c => (
                  <li key={c.id} className={c.done ? 'check-item done' : 'check-item'}>
                    <input type="checkbox" checked={c.done} onChange={e => setChecklist(cur => cur.map(x => (x.id === c.id ? { ...x, done: e.target.checked } : x)))} aria-label="Done" />
                    <input className="check-text" value={c.text} onChange={e => setChecklist(cur => cur.map(x => (x.id === c.id ? { ...x, text: e.target.value } : x)))} />
                    <button type="button" className="btn subtle" aria-label="Remove" onClick={() => setChecklist(cur => cur.filter(x => x.id !== c.id))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="check-add">
                <input
                  value={newCheck}
                  onChange={e => setNewCheck(e.target.value)}
                  placeholder="Add a step and press Enter"
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addCheck()
                    }
                  }}
                />
                <button type="button" className="btn" onClick={addCheck}>
                  Add
                </button>
                <button type="button" className="btn" disabled={(!title.trim() && !description.trim()) || aiBusy !== null} onClick={() => runAI('checklist')}>
                  {aiBusy === 'checklist' ? 'Thinking…' : '✨ Break it down'}
                </button>
              </div>
            </div>

            {isSocial && (
              <div className="social-section">
                <div className="field">
                  <span>Platforms</span>
                  <div className="platform-toggles">
                    {PLATFORMS.map(pl => (
                      <button key={pl} type="button" className={platforms.includes(pl) ? 'toggle on' : 'toggle'} onClick={() => togglePlatform(pl)}>
                        {PLATFORM_META[pl].label}
                      </button>
                    ))}
                  </div>
                </div>
                {platforms.length > 0 && (
                  <div className="field">
                    <span>
                      Per-platform overrides <small>(blank uses the description)</small>
                    </span>
                    <div className="variant-list">
                      {platforms.map(pl => (
                        <details key={pl} className="variant" open={!!variants[pl]?.trim()}>
                          <summary>
                            {PLATFORM_META[pl].label}
                            {variants[pl]?.trim() ? <em> — customized</em> : null}
                          </summary>
                          <textarea rows={3} value={variants[pl] ?? ''} onChange={e => setVariants(cur => ({ ...cur, [pl]: e.target.value }))} placeholder="Uses the description" />
                        </details>
                      ))}
                    </div>
                    <div className="ai-row">
                      <button type="button" className="btn" disabled={!description.trim() || aiBusy !== null} onClick={() => runAI('variants')}>
                        {aiBusy === 'variants' ? 'Generating…' : '✨ Generate platform variants'}
                      </button>
                    </div>
                  </div>
                )}
                {status === 'done' && (
                  <div className="field">
                    <span>
                      Results per platform <small>(fill in what you have)</small>
                    </span>
                    {platforms.map(pl => (
                      <div key={pl} className="metrics-row">
                        <span className="metrics-platform">{PLATFORM_META[pl].label}</span>
                        {METRIC_FIELDS.map(f => (
                          <label key={f} className="metric-input">
                            <small>{f}</small>
                            <input type="number" min={0} value={metrics[pl]?.[f] ?? ''} onChange={e => setMetric(pl, f, e.target.value)} />
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" className="btn subtle" onClick={() => setIsSocial(false)}>
                  Not a social post after all
                </button>
              </div>
            )}

            <div className="field">
              <span>
                Comments {comments.length > 0 && <small>({comments.length})</small>}
              </span>
              <ul className="comments">
                {comments.map(c => (
                  <li key={c.id} className="comment">
                    <div className="comment-meta">
                      <span>{fmtDateTime(c.createdAt)}</span>
                      <button type="button" className="btn subtle" aria-label="Delete comment" onClick={() => removeComment(c.id)}>
                        ✕
                      </button>
                    </div>
                    <div className="comment-body">{c.body}</div>
                  </li>
                ))}
              </ul>
              <div className="comment-form">
                <textarea
                  rows={2}
                  value={newComment}
                  onChange={e => setNewComment(e.target.value)}
                  placeholder={persisted ? 'Progress note, decision, blocker… (saves immediately)' : 'Progress note, decision, blocker…'}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      addComment()
                    }
                  }}
                />
                <button type="button" className="btn" disabled={!newComment.trim()} onClick={addComment}>
                  Comment
                </button>
              </div>
            </div>
          </div>

          <aside className="editor-side">
            <label className="field">
              <span>Project</span>
              <select value={projectId} onChange={e => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {projects
                  .filter(p => p.status !== 'archived' || p.id === projectId)
                  .map(p => (
                    <option key={p.id} value={p.id}>
                      {p.emoji ? `${p.emoji} ` : ''}
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>

            {members.length > 1 && (
              <label className="field">
                <span>Who's doing it</span>
                <select value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
                  <option value="">Anyone</option>
                  {members.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="field">
              <span>Status</span>
              <div className="segmented wrap">
                {TASK_STATUSES.map(s => (
                  <button key={s} type="button" className={status === s ? 'seg on' : 'seg'} onClick={() => setStatus(s)}>
                    {STATUS_META[s].label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span>Priority</span>
              <div className="segmented">
                {PRIORITIES.map(p => (
                  <button key={p} type="button" className={priority === p ? 'seg on' : 'seg'} onClick={() => setPriority(p)} style={priority === p ? { color: PRIORITY_META[p].color } : undefined}>
                    {PRIORITY_META[p].label}
                  </button>
                ))}
              </div>
            </div>

            {candidates.length > 0 && (
              <label className="field">
                <span>
                  Blocked by <small>(unblocks itself when they're done)</small>
                </span>
                <select
                  value=""
                  onChange={e => {
                    const id = e.target.value
                    if (id && !blockedBy.includes(id)) {
                      setBlockedBy(cur => [...cur, id])
                      if (status === 'todo') setStatus('blocked')
                    }
                  }}
                >
                  <option value="">Add a blocker…</option>
                  {candidates
                    .filter(c => c.id !== base.id && !blockedBy.includes(c.id))
                    .map(c => (
                      <option key={c.id} value={c.id}>
                        {c.title || 'Untitled'}
                      </option>
                    ))}
                </select>
                {blockedBy.length > 0 && (
                  <span className="chips blockers">
                    {blockedBy.map(id => {
                      const c = candidates.find(x => x.id === id)
                      return (
                        <button key={id} type="button" className="toggle on" onClick={() => setBlockedBy(cur => cur.filter(x => x !== id))} title="Remove blocker">
                          {c?.status === 'done' ? '✓ ' : '⏳ '}
                          {c?.title ?? 'Unknown task'} ✕
                        </button>
                      )
                    })}
                  </span>
                )}
              </label>
            )}

            <label className="field">
              <span>Due</span>
              <input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} />
            </label>

            {status === 'done' && (
              <label className="field">
                <span>Completed</span>
                <input type="datetime-local" value={completedAt} onChange={e => setCompletedAt(e.target.value)} />
              </label>
            )}

            <div className="field-row costs">
              <label className="field">
                <span>Estimate</span>
                <input inputMode="decimal" value={estimateCost} onChange={e => setEstimateCost(e.target.value)} placeholder="0" />
              </label>
              <label className="field">
                <span>Actual cost</span>
                <input inputMode="decimal" value={actualCost} onChange={e => setActualCost(e.target.value)} placeholder="0" />
              </label>
            </div>

            <label className="field">
              <span>Repeat</span>
              <select value={freq} onChange={e => setFreq(e.target.value as RecurrenceFreq | '')}>
                <option value="">Doesn't repeat</option>
                {(Object.keys(RECURRENCE_META) as RecurrenceFreq[]).map(f => (
                  <option key={f} value={f}>
                    {RECURRENCE_META[f]}
                  </option>
                ))}
              </select>
              {freq && <small className="field-hint">When this is marked done, the next occurrence is created automatically.</small>}
            </label>

            <label className="field">
              <span>
                Tags <small>(comma-separated)</small>
              </span>
              <input value={tags} onChange={e => setTags(e.target.value)} placeholder="home, errand" />
              <button type="button" className="btn subtle ai-inline" disabled={(!description.trim() && !title.trim()) || aiBusy !== null} onClick={() => runAI('tags')}>
                {aiBusy === 'tags' ? 'Suggesting…' : '✨ Suggest tags'}
              </button>
            </label>

            {people.length > 0 && (
              <div className="field">
                <span>
                  People <small>(marking this done counts as seeing them)</small>
                </span>
                {/* only who is actually attached is listed; the rest are found by
                    typing, so a long contact list never fills the editor */}
                {peopleIds.length > 0 && (
                  <div className="platform-toggles attendees">
                    {peopleIds.map(id => {
                      const p = people.find(x => x.id === id)
                      return (
                        <button key={id} type="button" className="toggle on" onClick={() => setPeopleIds(cur => cur.filter(x => x !== id))} title="Remove">
                          {p?.emoji ? `${p.emoji} ` : ''}
                          {p?.name ?? 'Unknown'} ✕
                        </button>
                      )
                    })}
                  </div>
                )}
                <input
                  className="people-picker-search"
                  value={peopleQuery}
                  onChange={e => setPeopleQuery(e.target.value)}
                  placeholder={peopleIds.length ? 'Add someone else…' : 'Search people to add…'}
                />
                {peopleQuery.trim() && (
                  <div className="platform-toggles picker-results">
                    {people
                      .filter(p => !peopleIds.includes(p.id) && p.name.toLowerCase().includes(peopleQuery.trim().toLowerCase()))
                      .slice(0, 8)
                      .map(p => (
                        <button
                          key={p.id}
                          type="button"
                          className="toggle"
                          onClick={() => {
                            setPeopleIds(cur => [...cur, p.id])
                            setPeopleQuery('')
                          }}
                        >
                          {p.emoji ? `${p.emoji} ` : ''}
                          {p.name}
                        </button>
                      ))}
                    {people.filter(p => !peopleIds.includes(p.id) && p.name.toLowerCase().includes(peopleQuery.trim().toLowerCase())).length === 0 && (
                      <small className="muted">No match.</small>
                    )}
                  </div>
                )}
              </div>
            )}

            <label className="field">
              <span>GitHub</span>
              <input value={githubUrl} onChange={e => setGithubUrl(e.target.value)} placeholder="Issue, PR, repo or project URL" />
            </label>
            {githubUrl.trim() && <GithubCard url={githubUrl.trim()} />}
            {!githubUrl.trim() && project?.githubUrl && parseGithubUrl(project.githubUrl)?.repo && (
              <button
                type="button"
                className="btn subtle ai-inline"
                disabled={!title.trim() || aiBusy !== null}
                onClick={async () => {
                  setAiError('')
                  try {
                    const issue = await createIssue(project.githubUrl!, title.trim(), description.trim())
                    setGithubUrl(issue.url)
                  } catch (e) {
                    setAiError((e as Error).message)
                  }
                }}
              >
                Create a GitHub issue in {parseGithubUrl(project.githubUrl)!.repo}
              </button>
            )}

            <label className="field">
              <span>Link</span>
              <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://…" />
            </label>

            <label className="field">
              <span>Notes</span>
              <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Private scratch space" />
            </label>

            <div className="field">
              <span>Images</span>
              <div className="media-grid">
                {mediaIds.map(id => (
                  <span key={id} className="media-thumb">
                    {thumbs[id] ? <img src={thumbs[id]} alt="" /> : <span className="media-missing">?</span>}
                    <button type="button" className="media-remove" aria-label="Remove image" onClick={() => setMediaIds(cur => cur.filter(x => x !== id))}>
                      ✕
                    </button>
                  </span>
                ))}
                <button type="button" className="media-add" onClick={() => mediaInput.current?.click()}>
                  + Image
                </button>
                <input
                  ref={mediaInput}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={e => {
                    addMedia(e.target.files)
                    e.target.value = ''
                  }}
                />
              </div>
            </div>

            <div className="field">
              <span>Files</span>
              <ul className="attachments">
                {attachments.map(a => (
                  <li key={a.id}>
                    <button type="button" className="attachment" onClick={() => openAttachment(a)} title="Open / download">
                      📎 {a.name} <small>{a.size > 1_000_000 ? `${(a.size / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1000))} KB`}</small>
                    </button>
                    <button type="button" className="btn subtle" aria-label="Remove file" onClick={() => setAttachments(cur => cur.filter(x => x.id !== a.id))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
                + Attach a file
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={e => {
                  addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>

            {!isSocial && (
              <button type="button" className="btn subtle" onClick={enableSocial}>
                📣 This is a social post
              </button>
            )}
            {aiError && <p className="warn">{aiError}</p>}
          </aside>
        </div>

        <footer className="modal-foot">
          {task && (
            <ConfirmButton onConfirm={() => onDelete(task.id)} confirmLabel="Click again to delete">
              Delete
            </ConfirmButton>
          )}
          <span className="spacer" />
          {project && <small className="muted">in {project.name}</small>}
          {overLimit.length > 0 && <span className="warn">Over the limit for {overLimit.map(pl => PLATFORM_META[pl].short).join(', ')}</span>}
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
