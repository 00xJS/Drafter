import type { CapturedFields, RefineMode } from './ai'
import { newerStamp } from './itemops'
import type { Attachment, Bill, ChecklistItem, Comment, Priority, RecurrenceFreq, Task, TaskStatus } from './types'
import { fromLocalInput, toLocalInput } from './utils'

/*
 * The task editor's form, and the rules that decide what a save writes. Pure
 * (no React, no DOM) so those rules are tested in node; TaskEditor.tsx holds
 * the form in a useReducer and its sections in components/taskeditor/ render it.
 */

/** Every field the editor edits, as its input holds it: dates as datetime-local text, tags and money as typed. */
export interface TaskForm {
  title: string
  description: string
  projectId: string
  status: TaskStatus
  priority: Priority
  dueAt: string
  completedAt: string
  tags: string
  notes: string
  link: string
  githubUrl: string
  checklist: ChecklistItem[]
  comments: Comment[]
  freq: RecurrenceFreq | ''
  mediaIds: string[]
  peopleIds: string[]
  placeId: string | undefined
  attachments: Attachment[]
  estimateCost: string
  actualCost: string
  bill: Bill | undefined
  blockedBy: string[]
  assigneeId: string
}

/** Which ✨ helper is running, if any (shared by the editor's sections). */
export type AiBusy = 'tags' | 'checklist' | 'capture' | RefineMode | null

export function initForm(base: Task): TaskForm {
  return {
    title: base.title,
    description: base.description,
    projectId: base.projectId ?? '',
    status: base.status,
    priority: base.priority,
    dueAt: toLocalInput(base.dueAt),
    completedAt: toLocalInput(base.completedAt),
    tags: base.tags.join(', '),
    notes: base.notes ?? '',
    link: base.link ?? '',
    githubUrl: base.githubUrl ?? '',
    checklist: base.checklist ?? [],
    comments: base.comments ?? [],
    freq: base.recurrence?.freq ?? '',
    mediaIds: base.mediaIds ?? [],
    peopleIds: base.peopleIds ?? [],
    placeId: base.placeId,
    attachments: base.attachments ?? [],
    estimateCost: base.estimateCost !== undefined ? String(base.estimateCost) : '',
    actualCost: base.actualCost !== undefined ? String(base.actualCost) : '',
    bill: base.bill,
    blockedBy: base.blockedBy ?? [],
    assigneeId: base.assigneeId ?? '',
  }
}

/** New values for some fields, or a function of the latest form (for writes that land after an await). */
export type FormPatch = Partial<TaskForm> | ((form: TaskForm) => Partial<TaskForm>)
export type SetForm = (patch: FormPatch) => void

interface Named {
  id: string
  name: string
}

/** One edit to a checklist. Items for an add are made by the caller (ids included) so the rules stay pure. */
export type StepOp =
  | { type: 'add'; items: ChecklistItem[] }
  | { type: 'tick'; id: string; done: boolean }
  | { type: 'rename'; id: string; text: string }
  | { type: 'remove'; id: string }

export type FormAction =
  | { type: 'set'; patch: FormPatch }
  /** Fields parsed from a captured sentence; project and people names are matched against these. */
  | { type: 'applyCapture'; capture: CapturedFields; projects: Named[]; people: Named[] }
  | { type: 'step'; op: StepOp }

export function formReducer(form: TaskForm, action: FormAction): TaskForm {
  switch (action.type) {
    case 'set':
      return { ...form, ...(typeof action.patch === 'function' ? action.patch(form) : action.patch) }
    case 'step':
      return { ...form, checklist: applyStep(form.checklist, action.op) }
    case 'applyCapture': {
      const { capture: c, projects, people } = action
      const next = { ...form }
      if (c.title) next.title = c.title
      if (c.dueAt) next.dueAt = toLocalInput(c.dueAt)
      if (c.priority) next.priority = c.priority
      if (c.projectName) {
        const p = projects.find(x => x.name.toLowerCase() === c.projectName!.toLowerCase())
        if (p) next.projectId = p.id
      }
      if (c.peopleNames?.length) {
        const ids = c.peopleNames.map(n => people.find(p => p.name.toLowerCase() === n.toLowerCase())?.id).filter((id): id is string => !!id)
        if (ids.length) next.peopleIds = [...new Set([...next.peopleIds, ...ids])]
      }
      if (c.tags?.length) next.tags = [...new Set([...next.tags.split(',').map(t => t.trim()).filter(Boolean), ...c.tags!])].join(', ')
      if (c.recurrence) next.freq = c.recurrence
      return next
    }
  }
}

// ---- the checklist -----------------------------------------------------------

/** A checklist after one edit. Steps are trimmed, blank ones never added, and a rename to nothing is no rename. */
export function applyStep(list: ChecklistItem[], op: StepOp): ChecklistItem[] {
  switch (op.type) {
    case 'add': {
      const fresh = op.items.map(c => ({ ...c, text: c.text.trim() })).filter(c => c.text && !list.some(x => x.id === c.id))
      return fresh.length > 0 ? [...list, ...fresh] : list
    }
    case 'tick':
      return list.map(c => (c.id === op.id ? { ...c, done: op.done } : c))
    case 'rename': {
      const text = op.text.trim()
      return text ? list.map(c => (c.id === op.id ? { ...c, text } : c)) : list
    }
    case 'remove':
      return list.filter(c => c.id !== op.id)
  }
}

/**
 * On a saved task every checklist edit — add, tick, rename, remove — is written
 * as it happens, onto the freshest copy (so a tick from the phone survives a
 * rename here), and never by Save. Null when the edits change nothing.
 */
export function commitStep(current: Task, ...ops: StepOp[]): Task | null {
  const before = current.checklist ?? []
  const after = ops.reduce(applyStep, before)
  if (JSON.stringify(after) === JSON.stringify(before)) return null
  return { ...current, checklist: after.length > 0 ? after : undefined, updatedAt: newerStamp(current.updatedAt) }
}

/**
 * Steps typed in but not yet written: a rename is written when its field is
 * left, and Save or Close can come while it still has focus. `typed` holds the
 * ids typed into since their last write, so a step only passed through never
 * overwrites a rename made elsewhere.
 */
export function pendingRenames(checklist: ChecklistItem[], typed: ReadonlySet<string>): StepOp[] {
  return checklist.filter(c => typed.has(c.id) && c.text.trim()).map(c => ({ type: 'rename', id: c.id, text: c.text }))
}

// ---- what a save writes ------------------------------------------------------------

/** A typed amount, or undefined when it is blank, negative or not a number. */
export const money = (v: string) => {
  const n = Number(v.replace(/[,\s£$€]/g, ''))
  return v.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined
}

/** Estimate and actual cost belong to bills. Any other task shows them only while it has a value, so none is hidden silently. */
export function costsVisible(form: Pick<TaskForm, 'bill' | 'estimateCost' | 'actualCost'>, base: Pick<Task, 'estimateCost' | 'actualCost'>): boolean {
  return !!form.bill || base.estimateCost !== undefined || base.actualCost !== undefined || !!form.estimateCost.trim() || !!form.actualCost.trim()
}

/** The form's current value for every editable field, in Task shape. */
export function formValues(form: TaskForm, base: Task, persisted: boolean) {
  const { title, description, projectId, status, priority, dueAt, completedAt, tags, notes, link, githubUrl, checklist, comments, mediaIds, freq, bill, peopleIds, placeId, attachments, estimateCost, actualCost, blockedBy, assigneeId } = form
  return {
    title: title.trim(),
    description,
    // there is no project control: this is the task's own project (or a preset's), carried through untouched
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
    // comments and every checklist edit on a persisted task are committed as they're made
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

/** The same fields as the task was when the editor opened. */
export function baseValues(base: Task) {
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

export const isDirty = (form: TaskForm, base: Task, persisted: boolean) => JSON.stringify(formValues(form, base, persisted)) !== JSON.stringify(baseValues(base))

/**
 * What a save writes: only the fields the user changed, laid onto `current` —
 * the FRESHEST copy, so concurrent updates (a bot logging metrics, an edit on
 * another device) survive an open editor.
 */
export function mergeOnto(current: Task, form: TaskForm, base: Task, persisted: boolean): Task {
  const values = formValues(form, base, persisted)
  const was = baseValues(base)
  const next: Task = { ...current }
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    if (JSON.stringify(values[key]) !== JSON.stringify(was[key])) {
      ;(next as unknown as Record<string, unknown>)[key] = values[key]
    }
  }
  if (next.status === 'done') next.completedAt = next.completedAt ?? new Date().toISOString()
  else next.completedAt = undefined
  next.updatedAt = newerStamp(current.updatedAt)
  return next
}

/** A task with nothing in it is almost always an accidental open-and-close. */
export function isEmpty(t: Task): boolean {
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

// ---- versions ---------------------------------------------------------------------

/** One earlier copy of a task, from posts_history. */
export interface TaskVersion {
  replaced_at: string
  data: Task
  updated_at: string
  reason: string | null
}

/** posts_history rows as versions. `reason` is null on a database from before v3.11, which has no such column. */
export function versionRows(rows: readonly Record<string, unknown>[] | null): TaskVersion[] {
  return (rows ?? [])
    .map(row => ({
      replaced_at: row.replaced_at as string,
      updated_at: row.updated_at as string,
      data: row.data as Task,
      reason: typeof row.reason === 'string' ? row.reason : null,
    }))
    .filter(v => v.data && typeof v.data === 'object')
}

/** What goes before a version's time in the list. */
export function versionNote(v: TaskVersion): string {
  // an edit that reached the server after a newer one had already won
  return v.reason === 'lost' ? 'Lost to a newer edit · ' : ''
}
