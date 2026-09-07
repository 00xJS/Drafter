import { useEffect, useMemo, useRef, useState } from 'react'
import {
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
import { ConfirmButton } from './ConfirmButton'

interface Props {
  task?: Task
  preset?: Partial<Task>
  projects: Project[]
  people: Person[]
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

export function TaskEditor({ task, preset, projects, people, getLatest, onSave, onCommit, onDelete, onClose }: Props) {
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

  function save() {
    onSave(merged())
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
                  People <small>(done = seen them)</small>
                </span>
                <div className="platform-toggles">
                  {people.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      className={peopleIds.includes(p.id) ? 'toggle on' : 'toggle'}
                      onClick={() => setPeopleIds(cur => (cur.includes(p.id) ? cur.filter(x => x !== p.id) : [...cur, p.id]))}
                    >
                      {p.emoji ? `${p.emoji} ` : ''}
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="field">
              <span>GitHub</span>
              <input value={githubUrl} onChange={e => setGithubUrl(e.target.value)} placeholder="Issue, PR, repo or project URL" />
            </label>
            {githubUrl.trim() && <GithubCard url={githubUrl.trim()} />}

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
