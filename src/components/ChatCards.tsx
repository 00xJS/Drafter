import { useState } from 'react'
import {
  cardKey,
  cardState,
  chatRecordId,
  describeAction,
  noteBody,
  personChoices,
  placeChoices,
  recipeChoices,
  withPick,
  type ChatData,
  type NamePick,
  type NeedPick,
} from '../chatactions'
import { blankNote, noteToSave } from './notes/model'
import { MEAL_SLOTS, MEAL_SLOT_META, PRIORITIES, PRIORITY_META, type ChatAction, type ChatOutcome, type ChatTurn, type Meal, type Note, type Person, type Place, type PlaceCategory, type Recipe } from '../types'
import { MealSlotRow } from './MealSlotRow'
import { Modal, ModalHead } from './Modal'
import { PeoplePicker } from './PeoplePicker'
import { PlacePicker } from './PlacePicker'
import { RichNotes } from './RichNotes'

// The suggestions under one of the assistant's answers, a card each: one line
// to read, details on a tap, and Apply · Edit · Skip. Nothing here writes to
// the planner — each button hands the suggestion to the chat (Chat.tsx), which
// applies it through the store and writes the line that settles the card.
// What a card shows is read from the thread (`outcomes`), so it says the same
// on every device.

type ActionOf<T extends ChatAction['type']> = Extract<ChatAction, { type: T }>

/** What the cards can ask of the chat. Absent: the cards are shown, and nothing on them can be pressed. */
export interface CardHandlers {
  /** Apply these, as they stand now (names picked, fields edited). */
  apply(items: { index: number; action: ChatAction }[]): void
  skip(index: number, action: ChatAction): void
  /** Take an apply or a skip back. */
  undo(index: number): void
  /** Whether this session can still undo what the card applied. */
  canUndo(index: number): boolean
  /** Open the app's own editor on it: the task editor, or the event editor. */
  edit(index: number, action: ChatAction): void
  /** A note written in the card's note sheet. */
  saveNote(index: number, note: Note): void
  /** Go to what an applied card made. */
  open(index: number, action: ChatAction, outcome: ChatOutcome): void
  /** Somebody or somewhere typed into a picker, saved as People and Places save them; a dish typed into the meal picker. */
  savePerson(p: Person): void
  savePlace(p: Place): void
  createPlace(name: string, kind: PlaceCategory): Place
  createRecipe(name: string): Recipe
}

/** Which suggestions edit in place; the task and the event open the app's editors instead, and a note its sheet. */
const INLINE = new Set<ChatAction['type']>(['update_task', 'add_grocery', 'log_visit', 'plan_meal'])

const quoted = (s: string) => `“${s}”`

/** The picker for one name nothing matched. */
function NameFix({ need, action, data, onPick }: { need: NeedPick; action: ChatAction; data: ChatData; onPick(p: NamePick): void }) {
  if (need.field === 'people') {
    return (
      <div className="chat-card-fix">
        <label>
          <span>Who is {quoted(need.name)}?</span>
          <select value="" onChange={e => e.target.value && onPick({ field: 'people', index: need.index, id: e.target.value })}>
            <option value="">Pick someone…</option>
            {personChoices(need.name, data.people).map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn subtle" onClick={() => onPick({ field: 'people', index: need.index, id: null })}>
          Leave out
        </button>
      </div>
    )
  }
  if (need.field === 'dish') {
    return (
      <div className="chat-card-fix">
        <label>
          <span>{quoted(need.name)} isn’t one of your recipes.</span>
          <select value="" onChange={e => e.target.value && onPick({ field: 'dish', id: e.target.value })}>
            <option value="">Pick a recipe…</option>
            {recipeChoices(need.name, data.recipes).map(r => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn subtle" onClick={() => onPick({ field: 'dish', id: 'new' })}>
          New recipe
        </button>
      </div>
    )
  }
  return (
    <div className="chat-card-fix">
      <label>
        <span>{quoted(need.name)} isn’t one of your places.</span>
        <select value="" onChange={e => e.target.value && onPick({ field: 'place', id: e.target.value })}>
          <option value="">Pick a place…</option>
          {placeChoices(need.name, data.places).map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {action.type === 'plan_meal' && (
        <button type="button" className="btn subtle" onClick={() => onPick({ field: 'place', id: null })}>
          No saved place
        </button>
      )}
    </div>
  )
}

/** Save and Cancel under an inline edit. */
function EditFoot({ ready, onSave, onCancel }: { ready: boolean; onSave(): void; onCancel(): void }) {
  return (
    <div className="chat-card-acts">
      <button type="button" className="btn primary" disabled={!ready} onClick={onSave}>
        Save
      </button>
      <button type="button" className="btn subtle" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

/** A task change, field by field: the day, the time, the status and the priority. */
function TaskChangeEdit({ action, onSave, onCancel }: { action: ActionOf<'update_task'>; onSave(a: ChatAction): void; onCancel(): void }) {
  const [date, setDate] = useState(action.date ?? '')
  const [time, setTime] = useState(action.time ?? '')
  const [status, setStatus] = useState(action.status ?? '')
  const [priority, setPriority] = useState(action.priority ?? '')
  const next: ActionOf<'update_task'> = {
    type: 'update_task',
    taskId: action.taskId,
    title: action.title,
    ...(date ? { date, ...(time ? { time } : {}) } : {}),
    ...(status ? { status: status as ActionOf<'update_task'>['status'] } : {}),
    ...(priority ? { priority: priority as ActionOf<'update_task'>['priority'] } : {}),
  }
  return (
    <div className="chat-card-edit">
      <div className="chat-card-row">
        <label className="field">
          <span>Due</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>At</span>
          <input type="time" value={time} disabled={!date} onChange={e => setTime(e.target.value)} />
        </label>
      </div>
      <div className="chat-card-row">
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={e => setStatus(e.target.value as typeof status)}>
            <option value="">As it is</option>
            <option value="todo">To do</option>
            <option value="done">Done</option>
            <option value="canceled">Canceled</option>
          </select>
        </label>
        <label className="field">
          <span>Priority</span>
          <select value={priority} onChange={e => setPriority(e.target.value as typeof priority)}>
            <option value="">As it is</option>
            {PRIORITIES.map(p => (
              <option key={p} value={p}>
                {PRIORITY_META[p].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <EditFoot ready={!!(next.date || next.status || next.priority)} onSave={() => onSave(next)} onCancel={onCancel} />
    </div>
  )
}

/** Grocery lines by name: each can be changed or taken out, and more added. */
function GroceryEdit({ action, onSave, onCancel }: { action: ActionOf<'add_grocery'>; onSave(a: ChatAction): void; onCancel(): void }) {
  const [items, setItems] = useState<string[]>(action.items)
  const clean = items.map(i => i.trim()).filter(Boolean)
  return (
    <div className="chat-card-edit">
      <ul className="chat-card-items">
        {items.map((item, i) => (
          <li key={i}>
            <input value={item} maxLength={80} aria-label={`Grocery item ${i + 1}`} onChange={e => setItems(cur => cur.map((x, j) => (j === i ? e.target.value : x)))} />
            <button type="button" className="btn subtle" aria-label={`Take ${item || 'this line'} out`} onClick={() => setItems(cur => cur.filter((_, j) => j !== i))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn subtle" onClick={() => setItems(cur => [...cur, ''])}>
        + Another item
      </button>
      <EditFoot ready={clean.length > 0} onSave={() => onSave({ ...action, items: clean })} onCancel={onCancel} />
    </div>
  )
}

/** A visit as People logs one: who, when, where and what you did. */
function VisitEdit({ action, data, on, onSave, onCancel }: { action: ActionOf<'log_visit'>; data: ChatData; on: CardHandlers; onSave(a: ChatAction): void; onCancel(): void }) {
  const [peopleIds, setPeopleIds] = useState(() => action.people.flatMap(p => (p.id ? [p.id] : [])))
  const [date, setDate] = useState(action.date)
  const [placeId, setPlaceId] = useState(action.place?.id)
  const [note, setNote] = useState(action.note ?? '')
  const people = peopleIds.flatMap(id => {
    const p = data.people.find(x => x.id === id)
    return p ? [{ name: p.name, id: p.id }] : []
  })
  const place = placeId ? data.places.find(p => p.id === placeId) : undefined
  const next: ActionOf<'log_visit'> = { type: 'log_visit', people, date, ...(place ? { place: { name: place.name, id: place.id } } : {}), ...(note.trim() ? { note: note.trim() } : {}) }
  return (
    <div className="chat-card-edit">
      <PeoplePicker peopleIds={peopleIds} onChange={update => setPeopleIds(update)} people={data.people} onSavePerson={on.savePerson} hint="each counts as seeing them" noun="task" />
      <label className="field">
        <span>When</span>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
      </label>
      <PlacePicker placeId={placeId} onChange={setPlaceId} places={data.places} onSavePlace={on.savePlace} label="Where?" />
      <label className="field">
        <span>What did you do?</span>
        <input value={note} maxLength={200} onChange={e => setNote(e.target.value)} placeholder="Sunday lunch, walk in the park…" />
      </label>
      <EditFoot ready={people.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)} onSave={() => onSave(next)} onCancel={onCancel} />
    </div>
  )
}

/** A stand-in meal for the slot picker to show the choice on; only its fields are read back. */
function draftMeal(a: ActionOf<'plan_meal'>): Meal | undefined {
  const base = { kind: 'meal' as const, id: 'chat-draft', date: a.date, slot: a.slot, createdAt: '', updatedAt: '' }
  if (a.out) return { ...base, out: true, title: a.place?.name ?? a.title ?? 'Eating out', ...(a.place?.id ? { placeId: a.place.id } : {}) }
  return a.dish?.id ? { ...base, recipeId: a.dish.id, title: a.dish.name } : undefined
}

/** A meal: the day, which meal, and what — through the Kitchen's own slot picker. */
function MealEdit({ action, data, on, onSave, onCancel }: { action: ActionOf<'plan_meal'>; data: ChatData; on: CardHandlers; onSave(a: ChatAction): void; onCancel(): void }) {
  const [draft, setDraft] = useState<ActionOf<'plan_meal'>>(action)
  const chosen = draftMeal(draft)
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(draft.date) && (draft.out ? !draft.place || !!draft.place.id : !!draft.dish && (!!draft.dish.id || !!draft.newDish))
  return (
    <div className="chat-card-edit">
      <label className="field">
        <span>Day</span>
        <input type="date" value={draft.date} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))} />
      </label>
      <div className="segmented chat-card-slots" role="group" aria-label="Which meal">
        {MEAL_SLOTS.map(s => (
          <button key={s} type="button" className={draft.slot === s ? 'seg on' : 'seg'} aria-pressed={draft.slot === s} onClick={() => setDraft(d => ({ ...d, slot: s }))}>
            {MEAL_SLOT_META[s].label}
          </button>
        ))}
      </div>
      {!chosen && draft.dish && !draft.out && <p className="field-hint">Now: {draft.newDish ? `${draft.dish.name} (a new recipe)` : `${quoted(draft.dish.name)}, to pick`}</p>}
      <MealSlotRow
        date={draft.date}
        slot={draft.slot}
        meal={chosen}
        recipes={data.recipes}
        places={data.places}
        meals={data.meals}
        mainOnly
        onSave={m =>
          setDraft(d => {
            const at = { type: 'plan_meal' as const, date: d.date, slot: d.slot }
            if (m.out) {
              const place = m.placeId ? data.places.find(p => p.id === m.placeId) : undefined
              return place ? { ...at, out: true, place: { name: place.name, id: place.id } } : { ...at, out: true, title: m.title }
            }
            const recipe = m.recipeId ? data.recipes.find(r => r.id === m.recipeId) : undefined
            return recipe ? { ...at, dish: { name: recipe.name, id: recipe.id } } : { ...at, dish: { name: m.title }, newDish: true }
          })
        }
        onClear={() => setDraft(d => ({ type: 'plan_meal', date: d.date, slot: d.slot }))}
        onCreatePlace={on.createPlace}
        onCreateRecipe={on.createRecipe}
      />
      <EditFoot ready={ready} onSave={() => onSave(draft)} onCancel={onCancel} />
    </div>
  )
}

/** A suggested note in the note editor's own editor, saved as Notes saves one. */
function NoteSheet({ action, id, onSave, onClose }: { action: ActionOf<'create_note'>; id: string; onSave(n: Note): void; onClose(): void }) {
  const [title, setTitle] = useState(action.title)
  const [body, setBody] = useState(() => noteBody(action.text))
  const note = noteToSave(blankNote(id, new Date().toISOString()), { title, body })
  return (
    <Modal onClose={onClose} className="modal chat-note-sheet">
      <ModalHead title="New note" />
      <div className="modal-body">
        <input className="note-title-input" aria-label="Note title" placeholder="Title" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} />
        <RichNotes value={body} onChange={setBody} status={note ? 'Private until you share it' : 'Needs a title or some text'} />
      </div>
      <footer className="modal-foot">
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!note} onClick={() => note && onSave(note)}>
          Save note
        </button>
      </footer>
    </Modal>
  )
}

interface Props {
  turn: ChatTurn
  /** The latest word on every card in the thread (outcomesByCard). */
  outcomes: ReadonlyMap<string, ChatOutcome>
  data: ChatData
  todayKey: string
  /** A reply is on its way, or cards are being applied: nothing new starts. */
  busy?: boolean
  on?: CardHandlers
}

/** The cards under one answer, and Apply all when more than one is waiting. */
export function ActionCards({ turn, outcomes, data, todayKey, busy, on }: Props) {
  const actions = turn.actions ?? []
  /** Suggestions as the person has changed them on this device: a name picked. */
  const [picked, setPicked] = useState<Record<number, ChatAction>>({})
  const [shown, setShown] = useState<Record<number, boolean>>({})
  const [editing, setEditing] = useState<number | null>(null)
  const [noteAt, setNoteAt] = useState<number | null>(null)
  if (!actions.length) return null

  const cards = actions.map((original, index) => {
    const action = picked[index] ?? original
    const outcome = outcomes.get(cardKey(turn.id, index))
    return { index, action, outcome, state: cardState(outcome), view: describeAction(action, data, todayKey) }
  })
  const ready = cards.filter(c => c.state === 'pending' && !c.view.blocked)
  const stillOn = !!on && !busy

  /** An inline edit's Save: the card closes, says what was edited, and that is what is applied. */
  const saveEdit = (handlers: CardHandlers, index: number) => (action: ChatAction) => {
    setEditing(null)
    setPicked(cur => ({ ...cur, [index]: action }))
    handlers.apply([{ index, action }])
  }
  const edit = (index: number, action: ChatAction) => {
    if (INLINE.has(action.type)) setEditing(e => (e === index ? null : index))
    else if (action.type === 'create_note') setNoteAt(index)
    else on?.edit(index, action)
  }

  return (
    <div className="chat-cards">
      <ul className="chat-card-list" aria-label="Suggested changes">
        {cards.map(({ index, action, outcome, state, view }) => {
          const rest = view.line.startsWith(`${view.kind} · `) ? view.line.slice(view.kind.length + 3) : view.line
          return (
            <li key={index} className={`chat-card ${state}`}>
              <button type="button" className="chat-card-line" aria-expanded={!!shown[index]} onClick={() => setShown(s => ({ ...s, [index]: !s[index] }))}>
                <strong>{view.kind}</strong>
                {rest !== view.line ? ` · ${rest}` : ''}
              </button>
              {shown[index] && view.details.length > 0 && (
                <ul className="chat-card-details">
                  {view.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
              {state === 'pending' && on && editing !== index && view.needs.map(need => <NameFix key={`${need.field}-${'index' in need ? need.index : ''}`} need={need} action={action} data={data} onPick={p => setPicked(cur => ({ ...cur, [index]: withPick(action, p, data) }))} />)}
              {state === 'pending' && editing === index && on && (
                <>
                  {action.type === 'update_task' && <TaskChangeEdit action={action} onSave={saveEdit(on, index)} onCancel={() => setEditing(null)} />}
                  {action.type === 'add_grocery' && <GroceryEdit action={action} onSave={saveEdit(on, index)} onCancel={() => setEditing(null)} />}
                  {action.type === 'log_visit' && <VisitEdit action={action} data={data} on={on} onSave={saveEdit(on, index)} onCancel={() => setEditing(null)} />}
                  {action.type === 'plan_meal' && <MealEdit action={action} data={data} on={on} onSave={saveEdit(on, index)} onCancel={() => setEditing(null)} />}
                </>
              )}
              {state === 'pending' && editing !== index && (
                <div className="chat-card-acts">
                  <button type="button" className="btn primary" disabled={!stillOn || !!view.blocked} onClick={() => on?.apply([{ index, action }])}>
                    Apply
                  </button>
                  <button type="button" className="btn" disabled={!stillOn} onClick={() => edit(index, action)}>
                    Edit
                  </button>
                  <button type="button" className="btn subtle" disabled={!stillOn} onClick={() => on?.skip(index, action)}>
                    Skip
                  </button>
                  {view.blocked && !view.needs.length && <small className="chat-card-hint">{view.blocked}</small>}
                </div>
              )}
              {state !== 'pending' && (
                <div className="chat-card-acts">
                  <span className="chat-card-state">{state === 'applied' ? '✓ Applied' : 'Skipped'}</span>
                  {(state === 'skipped' || on?.canUndo(index)) && (
                    <button type="button" className="btn subtle" disabled={!stillOn} onClick={() => on?.undo(index)}>
                      Undo
                    </button>
                  )}
                  {state === 'applied' && !!outcome?.ids?.length && (
                    <button type="button" className="btn subtle" disabled={!on} onClick={() => outcome && on?.open(index, action, outcome)}>
                      Open
                    </button>
                  )}
                </div>
              )}
              {noteAt === index && action.type === 'create_note' && on && (
                <NoteSheet
                  action={action}
                  id={chatRecordId('note', turn.id, index)}
                  onSave={n => {
                    setNoteAt(null)
                    on.saveNote(index, n)
                  }}
                  onClose={() => setNoteAt(null)}
                />
              )}
            </li>
          )
        })}
      </ul>
      {ready.length > 1 && (
        <button type="button" className="btn chat-cards-all" disabled={!stillOn} onClick={() => on?.apply(ready.map(c => ({ index: c.index, action: c.action })))}>
          Apply all ({ready.length})
        </button>
      )}
    </div>
  )
}
