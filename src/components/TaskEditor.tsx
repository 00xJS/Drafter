import { useEffect, useReducer, useRef, useState } from 'react'
import { Person, Place, Project, Task } from '../types'
import { duplicateTask } from '../taskutils'
import { uid } from '../utils'
import { RefineMode, CapturedFields, captureSeed, isSimpleDateCapture, parseCapture, refineDescription, suggestChecklist, suggestTags } from '../ai'
import { AiBusy, FormPatch, formReducer, initForm, isDirty, isEmpty, mergeOnto } from '../taskform'
import { ConfirmButton } from './ConfirmButton'
import { CaptureProposal } from './taskeditor/CaptureProposal'
import { DescriptionField, RefineProposal } from './taskeditor/DescriptionField'
import { ChecklistField } from './taskeditor/ChecklistField'
import { CommentsField } from './taskeditor/CommentsField'
import { AssignFields } from './taskeditor/AssignFields'
import { DueFields } from './taskeditor/DueFields'
import { BillCostRepeat } from './taskeditor/BillCostRepeat'
import { PeoplePlaceTags } from './taskeditor/PeoplePlaceTags'
import { LinksNotes } from './taskeditor/LinksNotes'
import { Images } from './taskeditor/Images'
import { Attachments } from './taskeditor/Attachments'
import { VersionsPanel } from './taskeditor/VersionsPanel'

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

  // every field lives in one reducer (src/taskform.ts); text typed but not yet
  // added (a step, a comment, a search) stays in the section that owns it
  const [form, dispatch] = useReducer(formReducer, base, initForm)
  const set = (patch: FormPatch) => dispatch({ type: 'set', patch })
  const addChecks = (texts: string[]) => dispatch({ type: 'addCheck', items: texts.map(text => ({ id: uid(), text, done: false })) })
  const { title, description, tags } = form

  const [aiBusy, setAiBusy] = useState<AiBusy>(null)
  const [aiError, setAiError] = useState('')
  /** A proposed rewrite of the description, waiting for the user to accept or discard it. */
  const [proposal, setProposal] = useState<RefineProposal | null>(null)
  const [captureProposal, setCaptureProposal] = useState<CapturedFields | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (task || !capture) return
    const seed = captureSeed(base.title, base.description, base.link)
    if (!seed.text.trim() && !seed.url) return
    let live = true
    ;(async () => {
      setAiBusy('capture')
      try {
        if (seed.url && !base.link) set({ link: seed.url })
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
    dispatch({ type: 'applyCapture', capture: c, projects, people })
    setCaptureProposal(null)
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
        set({ tags: [...existing, ...suggested.filter(t => !existing.includes(t))].join(', ') })
      } else {
        const steps = await suggestChecklist(title, description)
        addChecks(steps)
      }
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAiBusy(null)
    }
  }

  /** The freshest copy in the store: a save merges onto it, and on a saved task ticks and comments write straight onto it. */
  const latest = () => getLatest(base.id) ?? base
  const merged = () => mergeOnto(latest(), form, base, persisted)

  function requestClose() {
    if (isDirty(form, base, persisted) && !window.confirm('Discard your changes?')) return
    onClose()
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
    if (isDirty(form, base, persisted)) onCommit(current)
    onDuplicate(duplicateTask(current))
  }

  const project = projects.find(p => p.id === form.projectId)

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
                onChange={e => set({ title: e.target.value })}
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
              <CaptureProposal proposal={captureProposal} parsing={aiBusy === 'capture'} onApply={() => applyCapture(captureProposal)} onDismiss={() => setCaptureProposal(null)} />
            )}
            {aiBusy === 'capture' && !captureProposal && <p className="muted">Parsing capture…</p>}

            <DescriptionField description={description} set={set} aiBusy={aiBusy} onRefine={runAI} proposal={proposal} setProposal={setProposal} />
            <ChecklistField
              checklist={form.checklist}
              set={set}
              addChecks={addChecks}
              persisted={persisted}
              latest={latest}
              onCommit={onCommit}
              title={title}
              description={description}
              aiBusy={aiBusy}
              onBreakDown={() => runAI('checklist')}
            />
            <CommentsField comments={form.comments} set={set} persisted={persisted} latest={latest} onCommit={onCommit} />
          </div>

          <aside className="editor-side">
            <AssignFields form={form} set={set} projects={projects} members={members} candidates={candidates} taskId={base.id} />
            <DueFields form={form} set={set} />
            <BillCostRepeat form={form} set={set} />
            <PeoplePlaceTags form={form} set={set} people={people} places={places} onSavePlace={onSavePlace} aiBusy={aiBusy} onSuggestTags={() => runAI('tags')} />
            <LinksNotes form={form} set={set} project={project} aiBusy={aiBusy} setAiError={setAiError} />
            <Images mediaIds={form.mediaIds} set={set} />
            <Attachments attachments={form.attachments} set={set} setAiError={setAiError} />

            {aiError && <p className="warn">{aiError}</p>}

            {task && <VersionsPanel task={task} getLatest={getLatest} onCommit={onCommit} onClose={onClose} />}
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
