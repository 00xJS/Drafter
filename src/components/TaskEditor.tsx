import { useEffect, useReducer, useRef, useState } from 'react'
import { Person, Place, Project, Task } from '../types'
import { duplicateTask } from '../taskutils'
import { uid } from '../utils'
import { RefineMode, parseCapture, refineDescription, suggestChecklist, suggestTags } from '../ai'
import { CapturedFields, captureSeed, simpleDateCapture } from '../capture'
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
  /** The reader's own account id, when the planner is shared with a household. */
  myId?: string | null
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
  /**
   * On a shared meal's cook task: the recipe it follows (null when the meal is
   * not a recipe yet), and how to keep what was written here in it for next time.
   */
  cookRecipe?: { name: string | null; onSave(t: Task): void }
}

/** The buttons that ask a server for something: the ✨ rewrites, Break it down, Suggest tags, and Create a GitHub issue. */
type AiSource = 'refine' | 'checklist' | 'tags' | 'github'

/** A button's failure, said directly under it. */
const failure = (message: string | undefined) =>
  message ? (
    <p className="warn" role="alert">
      {message}
    </p>
  ) : null

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
  myId,
  candidates,
  getLatest,
  onSave,
  onDiscard,
  onCommit,
  onDelete,
  onDuplicate,
  onClose,
  cookRecipe,
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
        // A new task is yours until you share it, the same as a note. A preset
        // can still say otherwise (a cook task, a job for the other member).
        shared: false,
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
  // Why each ✨ button (or the GitHub issue button) last failed, kept by the
  // button, so each failure is said beside it. One line at the foot of the
  // form was two to four screens below the button on a phone.
  const [aiErrors, setAiErrors] = useState<Partial<Record<AiSource, string>>>({})
  const setAiError = (source: AiSource, message: string) => setAiErrors(e => ({ ...e, [source]: message }))
  /** A proposed rewrite of the description, waiting for the user to accept or discard it. */
  const [proposal, setProposal] = useState<RefineProposal | null>(null)
  const [captureProposal, setCaptureProposal] = useState<CapturedFields | null>(null)

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
        // people only: there is one home project, and a sentence never files a new task under one
        const parsed = await parseCapture(seed.text || seed.url || base.title, {
          personNames: people.map(p => p.name),
        })
        if (!live) return
        const extra =
          parsed.dueAt ||
          parsed.priority ||
          parsed.peopleNames?.length ||
          parsed.tags?.length ||
          parsed.recurrence ||
          parsed.title !== base.title
        if (!extra) return
        // a date alone goes in with no Review tap, and so under the title as
        // typed (simpleDateCapture), into fields nobody has typed in since
        const simple = simpleDateCapture(parsed, seed.text || base.title)
        if (simple) {
          applyCapture(simple, initForm(base))
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

  function applyCapture(c: CapturedFields, asRead?: Pick<ReturnType<typeof initForm>, 'title' | 'dueAt'>) {
    dispatch({ type: 'applyCapture', capture: c, people, asRead })
    setCaptureProposal(null)
  }

  async function runAI(kind: 'tags' | 'checklist' | RefineMode) {
    const source: AiSource = kind === 'tags' || kind === 'checklist' ? kind : 'refine'
    setAiError(source, '')
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
      setAiError(source, (e as Error).message)
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

  /** The steps and notes written here go into the recipe; the task is saved and closed on the way. */
  function saveToRecipe() {
    if (!cookRecipe) return
    flushSteps()
    cookRecipe.onSave(merged())
  }

  function duplicate() {
    if (!task || !onDuplicate) return
    flushSteps()
    const current = merged()
    if (isDirty(form, base, persisted)) commit(current)
    onDuplicate(duplicateTask(current))
  }

  const project = projects.find(p => p.id === form.projectId)
  // A blank new task is title, due and who can see it. Everything else —
  // description, checklist, people, photos, repeat — waits behind More
  // details. A bill, or any saved task, opens already expanded.
  const [details, setDetails] = useState(() => persisted || costsVisible(initForm(base), base))

  return (
    // Modal owns Escape, the backdrop and focus; both close through
    // requestClose, which asks before throwing away unsaved changes
    <Modal
      onClose={requestClose}
      className="modal wide task-editor"
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
        <ModalHead title={task ? 'Edit task' : 'New task'} variant="compose">
          <button type="button" className="btn primary" onClick={save}>
            Save
          </button>
        </ModalHead>

        <div className="modal-body">
          <div className={details ? 'editor-grid' : undefined}>
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

              {!details && (
                <>
                  <DueFields form={form} set={set} />
                  <AssignFields form={form} set={set} members={members} candidates={[]} taskId={base.id} myId={myId} ownerId={base.ownerId} essentials />
                </>
              )}

              {details && (
                <>
                  <DescriptionField description={description} set={set} aiBusy={aiBusy} onRefine={runAI} proposal={proposal} setProposal={setProposal} />
                  {failure(aiErrors.refine)}
                  <DescriptionLinks form={form} set={set} project={project} aiBusy={aiBusy} setAiError={message => setAiError('github', message)} />
                  {failure(aiErrors.github)}
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
                  {failure(aiErrors.checklist)}
                  {cookRecipe && (
                    <div className="cook-recipe-save">
                      <button type="button" className="btn" onClick={saveToRecipe}>
                        {cookRecipe.name ? 'Save to recipe' : 'Save as recipe'}
                      </button>
                      <small className="muted">
                        {cookRecipe.name
                          ? `Adds the steps and notes you wrote here to “${cookRecipe.name}”, so they are there next time.`
                          : 'Keeps this meal as a recipe, with the steps and notes you wrote here, to plan again.'}
                      </small>
                    </div>
                  )}
                </>
              )}
            </div>

            {details && (
              <aside className="editor-side">
                <AssignFields form={form} set={set} members={members} candidates={candidates} taskId={base.id} myId={myId} ownerId={base.ownerId} />
                <DueFields form={form} set={set} />
                <BillCost form={form} set={set} showCosts={costsVisible(form, base)} members={members} />
                <PeoplePlace form={form} set={set} people={people} places={places} onSavePlace={onSavePlace} onSavePerson={onSavePerson} />
                <Images mediaIds={form.mediaIds} set={set} />
                <Attachments attachments={form.attachments} set={set} />
              </aside>
            )}
          </div>

          {details ? (
            <div className="editor-bottom">
              <div className="editor-bottom-row">
                <RepeatField freq={form.freq} set={set} />
                <TagsField form={form} set={set} aiBusy={aiBusy} onSuggestTags={() => runAI('tags')} />
              </div>
              {failure(aiErrors.tags)}

              <CommentsField comments={form.comments} set={set} persisted={persisted} latest={latest} onCommit={commit} myId={myId} members={members} />

              {task && <VersionsPanel task={task} getLatest={getLatest} onCommit={onCommit} onClose={onClose} />}
            </div>
          ) : (
            <button type="button" className="btn subtle editor-more" onClick={() => setDetails(true)}>
              More details
            </button>
          )}
        </div>

        {task && (
          <footer className="modal-foot">
            <ConfirmButton onConfirm={() => onDelete(task.id)} confirmLabel="Click again to delete">
              Delete
            </ConfirmButton>
            {onDuplicate && (
              <button type="button" className="btn subtle" onClick={duplicate}>
                Duplicate
              </button>
            )}
            <span className="spacer" />
            <small className="muted task-foot-note">⌘↩ to save</small>
          </footer>
        )}
    </Modal>
  )
}
