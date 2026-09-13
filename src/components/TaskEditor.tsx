import { useEffect, useReducer, useRef, useState } from 'react'
import { Person, Place, Project, Task } from '../types'
import { duplicateTask } from '../taskutils'
import { uid } from '../utils'
import { RefineMode, CapturedFields, captureSeed, isSimpleDateCapture, parseCapture, refineDescription, suggestChecklist, suggestTags } from '../ai'
import { AiBusy, FormPatch, StepOp, appendOnce, commitStep, costsVisible, formReducer, initForm, isDirty, isEmpty, mergeOnto, pendingRenames } from '../taskform'
import { ConfirmButton } from './ConfirmButton'
import { Modal, ModalHead } from './Modal'
import { CaptureProposal } from './taskeditor/CaptureProposal'
import { DescriptionField, RefineProposal } from './taskeditor/DescriptionField'
import { DescriptionLinks } from './taskeditor/DescriptionLinks'
import { ChecklistField } from './taskeditor/ChecklistField'
import { CommentsField } from './taskeditor/CommentsField'
import { AssignFields } from './taskeditor/AssignFields'
import { DueFields } from './taskeditor/DueFields'
import { BillCost } from './taskeditor/BillCost'
import { PeoplePlace } from './taskeditor/PeoplePlace'
import { Images } from './taskeditor/Images'
import { Attachments } from './taskeditor/Attachments'
import { RepeatField } from './taskeditor/RepeatField'
import { TagsField } from './taskeditor/TagsField'
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
  /** Save a person typed into the People picker who isn't in People yet; without it the picker only finds people. */
  onSavePerson?(p: Person): void
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
  /** Persist without closing (comments and checklist edits land immediately). */
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
  onSavePerson,
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
  const { title, description } = form

  const [aiBusy, setAiBusy] = useState<AiBusy>(null)
  const [aiError, setAiError] = useState('')
  /** A proposed rewrite of the description, waiting for the user to accept or discard it. */
  const [proposal, setProposal] = useState<RefineProposal | null>(null)
  const [captureProposal, setCaptureProposal] = useState<CapturedFields | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  /** The last copy this editor wrote: the store's reaches `getLatest` a render later, and a save straight after a write must build on it. */
  const wrote = useRef<Task | null>(null)
  /** Steps typed into since they were last written (see pendingRenames). */
  const typed = useRef(new Set<string>())

  useEffect(() => {
    if (task || !capture) return
    const seed = captureSeed(base.title, base.description, base.link)
    if (!seed.text.trim() && !seed.url) return
    let live = true
    ;(async () => {
      setAiBusy('capture')
      try {
        // a pasted or shared URL goes into the description, where it shows as a
        // link (a shared link is there already: the form opens with it)
        if (seed.url) set(f => ({ description: appendOnce(f.description, seed.url!) }))
        const parsed = await parseCapture(seed.text || seed.url || base.title, {
          // no project names: there is one home project, and a sentence never files a new task under one
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
        set(f => {
          const existing = f.tags
            .split(',')
            .map(t => t.trim().replace(/^#/, ''))
            .filter(Boolean)
          return { tags: [...existing, ...suggested.filter(t => !existing.includes(t))].join(', ') }
        })
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

  /** The freshest copy there is: a save merges onto it, and on a saved task steps and comments write straight onto it. */
  const latest = (): Task => {
    const stored = getLatest(base.id)
    const mine = wrote.current
    return mine && (!stored || Date.parse(mine.updatedAt) > Date.parse(stored.updatedAt)) ? mine : (stored ?? base)
  }
  const commit = (t: Task) => {
    wrote.current = t
    onCommit(t)
  }
  const merged = () => mergeOnto(latest(), form, base, persisted)

  /** A checklist edit: the form shows it, and on a saved task it is written now, onto the freshest copy — never through Save. */
  function onStep(op: StepOp) {
    if (op.type === 'rename') {
      // leaving a step you only passed through writes nothing
      if (!typed.current.has(op.id)) return
      typed.current.delete(op.id)
    }
    if (op.type === 'remove') typed.current.delete(op.id)
    dispatch({ type: 'step', op })
    if (!persisted) return
    const next = commitStep(latest(), op)
    if (next) commit(next)
  }
  const addChecks = (texts: string[]) => onStep({ type: 'add', items: texts.map(text => ({ id: uid(), text, done: false })) })
  const onType = (id: string, text: string) => {
    typed.current.add(id)
    set(f => ({ checklist: f.checklist.map(x => (x.id === id ? { ...x, text } : x)) }))
  }

  /** A rename still in its field when Save, Close or Duplicate is pressed is written first. */
  function flushSteps() {
    if (!persisted || typed.current.size === 0) return
    const ops = pendingRenames(form.checklist, typed.current)
    typed.current.clear()
    const next = commitStep(latest(), ...ops)
    if (next) commit(next)
  }

  function requestClose() {
    flushSteps()
    if (isDirty(form, base, persisted) && !window.confirm('Discard your changes?')) return
    onClose()
  }

  function save() {
    flushSteps()
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
    flushSteps()
    const current = merged()
    if (isDirty(form, base, persisted)) commit(current)
    onDuplicate(duplicateTask(current))
  }

  const project = projects.find(p => p.id === form.projectId)

  return (
    // Modal owns Escape, the backdrop and focus; both close through
    // requestClose, which asks before throwing away unsaved changes
    <Modal
      onClose={requestClose}
      className="modal wide"
      panelRef={modalRef}
      onKeyDown={e => {
        const target = e.target as HTMLElement
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          // the comment box keeps Cmd+Enter for adding a comment
          if (target.tagName === 'TEXTAREA' && target.closest('.activity')) return
          e.preventDefault()
          save()
        }
      }}
    >
        <ModalHead title={task ? 'Edit task' : 'New task'}>
          <button className="btn primary modal-head-save" onClick={save}>
            Save
          </button>
        </ModalHead>

        <div className="modal-body">
          <div className="editor-grid">
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
              <DescriptionLinks form={form} set={set} project={project} aiBusy={aiBusy} setAiError={setAiError} />
              <ChecklistField
                checklist={form.checklist}
                onType={onType}
                onStep={onStep}
                addChecks={addChecks}
                title={title}
                description={description}
                aiBusy={aiBusy}
                onBreakDown={() => runAI('checklist')}
              />
            </div>

            <aside className="editor-side">
              <AssignFields form={form} set={set} members={members} candidates={candidates} taskId={base.id} />
              <DueFields form={form} set={set} />
              <BillCost form={form} set={set} showCosts={costsVisible(form, base)} />
              <PeoplePlace form={form} set={set} people={people} places={places} onSavePlace={onSavePlace} onSavePerson={onSavePerson} />
              <Images mediaIds={form.mediaIds} set={set} />
              <Attachments attachments={form.attachments} set={set} setAiError={setAiError} />
            </aside>
          </div>

          {/* the foot of the form, full width: how often it comes round and its
              tags, then the Activity feed, then earlier versions */}
          <div className="editor-bottom">
            <div className="editor-bottom-row">
              <RepeatField freq={form.freq} set={set} />
              <TagsField form={form} set={set} aiBusy={aiBusy} onSuggestTags={() => runAI('tags')} />
            </div>

            {aiError && <p className="warn">{aiError}</p>}

            <CommentsField comments={form.comments} set={set} persisted={persisted} latest={latest} onCommit={commit} />

            {task && <VersionsPanel task={task} getLatest={getLatest} onCommit={onCommit} onClose={onClose} />}
          </div>
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
          <small className="muted task-foot-note">⌘↩ to save</small>
          {project && <small className="muted task-foot-note">in {project.name}</small>}
          <button className="btn" onClick={requestClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </footer>
    </Modal>
  )
}
