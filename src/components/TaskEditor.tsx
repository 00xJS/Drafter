import { useEffect, useRef, useState } from 'react'
import {
  Attachment,
  ChecklistItem,
  Comment,
  Person,
  Place,
  PRIORITIES,
  PRIORITY_META,
  PROJECT_COLORS,
  Priority,
  Project,
  RECURRENCE_META,
  BILL_KINDS,
  BILL_KIND_META,
  Bill,
  RecurrenceFreq,
  STATUS_META,
  Task,
  TaskStatus,
  pickerStatuses,
} from '../types'
import { newerStamp } from '../itemops'
import { duplicateTask } from '../taskutils'
import { fmtDateTime, fromLocalInput, toLocalInput, uid } from '../utils'
import { mediaURL, saveMedia } from '../media'
import { REFINE_META, RefineMode, CapturedFields, captureSeed, isSimpleDateCapture, parseCapture, refineDescription, suggestChecklist, suggestTags } from '../ai'
import { getSupabase } from '../supabase'
import { GithubCard } from './GithubCard'
import { createIssue, parseGithubUrl } from '../github'
import { ConfirmButton } from './ConfirmButton'

interface Props {
  task?: Task
  preset?: Partial<Task>
  /** Run sentence capture (AI + deterministic) on open for new tasks. */
  capture?: boolean
  projects: Project[]
  people: Person[]
  places?: Place[]
  onSavePlace?(p: Place): void
  /** Household members (empty when not in a household). */
  members: { id: string; displayName: string }[]
  /** Open tasks that could block this one (same project preferred). */
  candidates: Task[]
  /** The freshest copy in the store — save() merges onto it so fields the user
   *  did NOT touch keep concurrent edits (e.g. a bot adding a comment). */
  getLatest(id: string): Task | undefined
  onSave(t: Task): void
  /** Called instead of onSave when a brand-new task had nothing in it. */
  onDiscard?(): void
  /** Persist without closing (comments and checklist ticks land immediately). */
  onCommit(t: Task): void
  onDelete(id: string): void
  /** Persist a duplicated task and open it (parent owns store + navigation). */
  onDuplicate?(copy: Task): void
  onClose(): void
}

export function TaskEditor({
  task,
  preset,
  capture = false,
  projects,
  people,
  places = [],
  onSavePlace,
  members,
  candidates,
  getLatest,
  onSave,
  onDiscard,
  onCommit,
  onDelete,
  onDuplicate,
  onClose,
}: Props) {
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
  const [placeId, setPlaceId] = useState<string | undefined>(base.placeId)
  const [placeQuery, setPlaceQuery] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>(base.attachments ?? [])
  const [estimateCost, setEstimateCost] = useState(base.estimateCost !== undefined ? String(base.estimateCost) : '')
  const [actualCost, setActualCost] = useState(base.actualCost !== undefined ? String(base.actualCost) : '')
  const [bill, setBill] = useState<Bill | undefined>(base.bill)
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
  const [aiBusy, setAiBusy] = useState<'tags' | 'checklist' | 'capture' | RefineMode | null>(null)
  const [aiError, setAiError] = useState('')
  /** A proposed rewrite of the description, waiting for the user to accept or discard it. */
  const [proposal, setProposal] = useState<{ mode: RefineMode; text: string } | null>(null)
  const [captureProposal, setCaptureProposal] = useState<CapturedFields | null>(null)
  const [versions, setVersions] = useState<{ replaced_at: string; data: Task; updated_at: string }[] | null>(null)
  const [versionsBusy, setVersionsBusy] = useState(false)
  const mediaInput = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (task || !capture) return
    const seed = captureSeed(base.title, base.description, base.link)
    if (!seed.text.trim() && !seed.url) return
    let live = true
    ;(async () => {
      setAiBusy('capture')
      try {
        if (seed.url && !base.link) setLink(seed.url)
        const parsed = await parseCapture(seed.text || seed.url || base.title, {
          projectNames: projects.filter(p => p.status === 'active').map(p => p.name),
          personNames: people.map(p => p.name),
        })
        if (!live) return
        const extra =
          parsed.dueAt ||
          parsed.priority ||
          parsed.projectName ||
          parsed.peopleNames?.length ||
          parsed.tags?.length ||
          parsed.recurrence ||
          parsed.title !== base.title
        if (!extra) return
        if (isSimpleDateCapture(parsed, seed.text || base.title) && !parsed.priority && !parsed.projectName && !parsed.peopleNames?.length) {
          applyCapture(parsed)
          return
        }
        setCaptureProposal(parsed)
      } catch {
        /* offline / no key — deterministic path already inside parseCapture */
      } finally {
        if (live) setAiBusy(null)
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function applyCapture(c: CapturedFields) {
    if (c.title) setTitle(c.title)
    if (c.dueAt) setDueAt(toLocalInput(c.dueAt))
    if (c.priority) setPriority(c.priority)
    if (c.projectName) {
      const p = projects.find(x => x.name.toLowerCase() === c.projectName!.toLowerCase())
      if (p) setProjectId(p.id)
    }
    if (c.peopleNames?.length) {
      const ids = c.peopleNames.map(n => people.find(p => p.name.toLowerCase() === n.toLowerCase())?.id).filter((id): id is string => !!id)
      if (ids.length) setPeopleIds(cur => [...new Set([...cur, ...ids])])
    }
    if (c.tags?.length) setTags(cur => [...new Set([...cur.split(',').map(t => t.trim()).filter(Boolean), ...c.tags!])].join(', '))
    if (c.recurrence) setFreq(c.recurrence)
    setCaptureProposal(null)
  }

  async function loadVersions() {
    if (!task || versions !== null || versionsBusy) return
    const sb = getSupabase()
    if (!sb) {
      setVersions([])
      return
    }
    setVersionsBusy(true)
    try {
      const { data, error } = await sb
        .from('posts_history')
        .select('replaced_at, updated_at, data')
        .eq('id', task.id)
        .order('replaced_at', { ascending: false })
        .limit(20)
      if (error) throw error
      setVersions(
        (data ?? [])
          .map(row => ({
            replaced_at: row.replaced_at as string,
            updated_at: row.updated_at as string,
            data: row.data as Task,
          }))
          .filter(v => v.data && typeof v.data === 'object'),
      )
    } catch {
      setVersions([])
    } finally {
      setVersionsBusy(false)
    }
  }

  function restoreVersion(v: Task) {
    if (!task) return
    const current = getLatest(task.id) ?? task
    onCommit({ ...v, id: current.id, updatedAt: newerStamp(current.updatedAt), ownerId: current.ownerId })
    onClose()
  }

  function setDueChip(d: Date | null) {
    setDueAt(d ? toLocalInput(d.toISOString()) : '')
  }

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

  async function addMedia(files: FileList | null) {
    if (!files) return
    const ids: string[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      ids.push(await saveMedia(file))
    }
    if (ids.length > 0) setMediaIds(cur => [...cur, ...ids])
  }

  async function runAI(kind: 'tags' | 'checklist' | RefineMode) {
    setAiError('')
    setAiBusy(kind)
    try {
      if (kind === 'clarify' || kind === 'expand' || kind === 'summarize') {
        const text = await refineDescription(kind, title, description)
        setProposal({ mode: kind, text })
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
      checklist: persisted
        ? base.checklist
        : checklist.length > 0
          ? checklist.map(c => ({ ...c, text: c.text.trim() })).filter(c => c.text)
          : undefined,
      // comments and checklist ticks on a persisted task are committed as they're written
      comments: persisted ? base.comments : comments.length > 0 ? comments : undefined,
      mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
      recurrence: freq ? ({ freq } as Task['recurrence']) : undefined,
      social: base.social,
      // listed explicitly like every field here: leave it out and a bill saves as a plain task
      bill: bill ? { ...bill, payee: bill.payee?.trim() || undefined } : undefined,
      peopleIds: peopleIds.length > 0 ? peopleIds : undefined,
      placeId: placeId || undefined,
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
      bill: base.bill,
      peopleIds: base.peopleIds,
      placeId: base.placeId,
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
      !t.placeId &&
      !(t.attachments?.length) &&
      !(t.mediaIds?.length) &&
      !t.dueAt &&
      !t.tags.length &&
      !t.link &&
      !t.githubUrl &&
      !t.notes?.trim()
    )
  }

  function save() {
    const next = merged()
    if (!task && isEmpty(next)) {
      // brand-new and blank: discard rather than litter the list with "Untitled",
      // but say so — a task disappearing without a word is worse than a stray one
      onDiscard?.()
      onClose()
      return
    }
    onSave(next)
  }

  function duplicate() {
    if (!task || !onDuplicate) return
    const current = merged()
    if (isDirty()) onCommit(current)
    onDuplicate(duplicateTask(current))
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

  function toggleCheckItem(id: string, done: boolean) {
    setChecklist(cur => {
      const next = cur.map(x => (x.id === id ? { ...x, done } : x))
      if (persisted) {
        const current = getLatest(base.id) ?? base
        const cleaned = next.length > 0 ? next.map(c => ({ ...c, text: c.text.trim() })).filter(c => c.text) : undefined
        onCommit({ ...current, checklist: cleaned, updatedAt: newerStamp(current.updatedAt) })
      }
      return next
    })
  }

  const checkDone = checklist.filter(c => c.done).length
  const project = projects.find(p => p.id === projectId)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={e => {
          const target = e.target as HTMLElement
          const tag = target.tagName
          if (e.key === 'Escape') {
            e.preventDefault()
            requestClose()
            return
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            // comment box keeps Cmd+Enter for adding a comment
            if (tag === 'TEXTAREA' && target.closest('.comments')) return
            e.preventDefault()
            save()
          }
        }}
      >
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
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Book the electrician"
                autoFocus={!task}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !task && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault()
                    save()
                  }
                }}
              />
            </label>

            {captureProposal && (
              <div className="ai-proposal" onClick={e => e.preventDefault()}>
                <div className="ai-proposal-head">
                  <strong>Capture suggestion</strong>
                  <small>{aiBusy === 'capture' ? 'Parsing…' : 'Review, then apply or dismiss'}</small>
                </div>
                <ul className="capture-fields">
                  <li>
                    <strong>Title</strong> {captureProposal.title}
                  </li>
                  {captureProposal.dueAt && (
                    <li>
                      <strong>Due</strong> {fmtDateTime(captureProposal.dueAt)}
                    </li>
                  )}
                  {captureProposal.priority && (
                    <li>
                      <strong>Priority</strong> {captureProposal.priority}
                    </li>
                  )}
                  {captureProposal.projectName && (
                    <li>
                      <strong>Project</strong> {captureProposal.projectName}
                    </li>
                  )}
                  {captureProposal.peopleNames?.length ? (
                    <li>
                      <strong>People</strong> {captureProposal.peopleNames.join(', ')}
                    </li>
                  ) : null}
                  {captureProposal.tags?.length ? (
                    <li>
                      <strong>Tags</strong> {captureProposal.tags.join(', ')}
                    </li>
                  ) : null}
                  {captureProposal.recurrence && (
                    <li>
                      <strong>Repeat</strong> {captureProposal.recurrence}
                    </li>
                  )}
                </ul>
                <div className="ai-row">
                  <button type="button" className="btn primary" onClick={() => applyCapture(captureProposal)}>
                    Apply
                  </button>
                  <button type="button" className="btn subtle" onClick={() => setCaptureProposal(null)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {aiBusy === 'capture' && !captureProposal && <p className="muted">Parsing capture…</p>}

            <label className="field">
              <span>Description</span>
              <textarea rows={5} value={description} onChange={e => setDescription(e.target.value)} placeholder="What needs to happen, and why? Links, measurements, context…" />
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
            </label>

            <div className="field">
              <span>
                Checklist {checklist.length > 0 && <small>({checkDone}/{checklist.length} done)</small>}
              </span>
              <ul className="checklist">
                {checklist.map(c => (
                  <li key={c.id} className={c.done ? 'check-item done' : 'check-item'}>
                    <input type="checkbox" checked={c.done} onChange={e => toggleCheckItem(c.id, e.target.checked)} aria-label="Done" />
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
                {pickerStatuses(status).map(s => (
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
              <div className="due-chips">
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    const d = new Date()
                    d.setHours(18, 0, 0, 0)
                    setDueChip(d)
                  }}
                >
                  Today 18:00
                </button>
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    const d = new Date()
                    d.setDate(d.getDate() + 1)
                    d.setHours(9, 0, 0, 0)
                    setDueChip(d)
                  }}
                >
                  Tomorrow 09:00
                </button>
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    const d = new Date()
                    const delta = (6 - d.getDay() + 7) % 7 || 7
                    d.setDate(d.getDate() + delta)
                    d.setHours(10, 0, 0, 0)
                    setDueChip(d)
                  }}
                >
                  Weekend
                </button>
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    const d = new Date()
                    const delta = (1 - d.getDay() + 7) % 7 || 7
                    d.setDate(d.getDate() + delta)
                    d.setHours(9, 0, 0, 0)
                    setDueChip(d)
                  }}
                >
                  Next Monday
                </button>
                <button type="button" className="btn subtle" onClick={() => setDueChip(null)}>
                  Clear
                </button>
              </div>
            </label>

            {status === 'done' && (
              <label className="field">
                <span>Completed</span>
                <input type="datetime-local" value={completedAt} onChange={e => setCompletedAt(e.target.value)} />
              </label>
            )}

            <div className="field bill-field">
              <label className="field-inline">
                <input
                  type="checkbox"
                  checked={!!bill}
                  onChange={e => {
                    if (e.target.checked) {
                      setBill({ kind: 'bill' })
                      // a bill almost always comes round again
                      if (!freq) setFreq('monthly')
                    } else setBill(undefined)
                  }}
                />
                <span>This is a bill or payment</span>
              </label>
              {bill && (
                <div className="bill-fields">
                  <select value={bill.kind} onChange={e => setBill({ ...bill, kind: e.target.value as Bill['kind'] })} aria-label="Kind of payment">
                    {BILL_KINDS.map(k => (
                      <option key={k} value={k}>
                        {BILL_KIND_META[k].emoji} {BILL_KIND_META[k].label}
                      </option>
                    ))}
                  </select>
                  <input value={bill.payee ?? ''} onChange={e => setBill({ ...bill, payee: e.target.value })} placeholder="Paid to (optional)" aria-label="Paid to" />
                  <label className="field-inline">
                    <input type="checkbox" checked={!!bill.autopay} onChange={e => setBill({ ...bill, autopay: e.target.checked || undefined })} />
                    <span>Paid automatically</span>
                  </label>
                </div>
              )}
            </div>

            <div className="field-row costs">
              <label className="field">
                <span>{bill ? 'Amount due' : 'Estimate'}</span>
                <input inputMode="decimal" value={estimateCost} onChange={e => setEstimateCost(e.target.value)} placeholder="0" />
              </label>
              <label className="field">
                <span>{bill ? 'Paid' : 'Actual cost'}</span>
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

            <div className="field">
              <span>
                Where <small>(marking this done counts as an outing there)</small>
              </span>
              {placeId && (
                <div className="platform-toggles attendees">
                  {(() => {
                    const p = places.find(x => x.id === placeId)
                    return (
                      <button type="button" className="toggle on" onClick={() => setPlaceId(undefined)} title="Remove">
                        {p?.emoji ? `${p.emoji} ` : ''}
                        {p?.name ?? 'Unknown'} ✕
                      </button>
                    )
                  })()}
                </div>
              )}
              {!placeId && (
                <>
                  <input
                    className="people-picker-search"
                    value={placeQuery}
                    onChange={e => setPlaceQuery(e.target.value)}
                    placeholder="Search places…"
                  />
                  {placeQuery.trim() && (
                    <div className="platform-toggles picker-results">
                      {places
                        .filter(p => p.name.toLowerCase().includes(placeQuery.trim().toLowerCase()))
                        .slice(0, 8)
                        .map(p => (
                          <button
                            key={p.id}
                            type="button"
                            className="toggle"
                            onClick={() => {
                              setPlaceId(p.id)
                              setPlaceQuery('')
                            }}
                          >
                            {p.emoji ? `${p.emoji} ` : ''}
                            {p.name}
                          </button>
                        ))}
                      {onSavePlace &&
                        !places.some(p => p.name.toLowerCase() === placeQuery.trim().toLowerCase()) && (
                          <button
                            type="button"
                            className="toggle"
                            onClick={() => {
                              const now = new Date().toISOString()
                              const p: Place = {
                                kind: 'place',
                                id: uid(),
                                name: placeQuery.trim(),
                                color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
                                category: 'other',
                                createdAt: now,
                                updatedAt: now,
                              }
                              onSavePlace(p)
                              setPlaceId(p.id)
                              setPlaceQuery('')
                            }}
                          >
                            Create place “{placeQuery.trim()}”
                          </button>
                        )}
                      {!onSavePlace &&
                        places.filter(p => p.name.toLowerCase().includes(placeQuery.trim().toLowerCase())).length === 0 && (
                          <small className="muted">No match.</small>
                        )}
                    </div>
                  )}
                </>
              )}
            </div>

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

            {aiError && <p className="warn">{aiError}</p>}

            {task && (
              <details
                className="versions"
                onToggle={e => {
                  if ((e.target as HTMLDetailsElement).open) void loadVersions()
                }}
              >
                <summary>Versions</summary>
                {versionsBusy && <p className="muted">Loading…</p>}
                {versions && versions.length === 0 && <p className="empty">No earlier versions yet.</p>}
                {versions && versions.length > 0 && (
                  <ul className="versions-list">
                    {versions.map(v => (
                      <li key={v.replaced_at}>
                        <div className="dash-main">
                          <span className="dash-title">{v.data.title || 'Untitled'}</span>
                          <span className="dash-reason">{fmtDateTime(v.replaced_at)}</span>
                        </div>
                        <button type="button" className="btn" onClick={() => restoreVersion(v.data)}>
                          Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            )}
          </aside>
        </div>

        <footer className="modal-foot">
          {task && (
            <>
              <ConfirmButton onConfirm={() => onDelete(task.id)} confirmLabel="Click again to delete">
                Delete
              </ConfirmButton>
              {onDuplicate && (
                <button type="button" className="btn subtle" onClick={duplicate}>
                  Duplicate
                </button>
              )}
            </>
          )}
          <span className="spacer" />
          <small className="muted">⌘↩ to save</small>
          {project && <small className="muted">in {project.name}</small>}
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
