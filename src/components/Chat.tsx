import { KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CHAT_PAGE, CHAT_PROMPTS, newMessage, newTurn, recentContext, thread } from '../chat'
import {
  applyChatAction,
  askInThread,
  askWithActions,
  cardKey,
  cardState,
  chatActionContext,
  chatRecordId,
  describeAction,
  eventRecord,
  outcomeLine,
  outcomesByCard,
  taskPreset,
  todayIn,
  type Applied,
  type ChatActionContext,
  type ChatData,
  type ChatHost,
  type ChatReply,
} from '../chatactions'
import { dayLabel } from '../journal'
import { memberName, type HouseholdInfo } from '../household'
import { AskDoc, AskSources, prepareAsk } from '../ask'
import { MESSAGE_MAX, type CalendarEntry, type ChatAction, type ChatOutcomeState, type ChatTurn, type Message, type Person, type Place, type PlaceCategory, type Task } from '../types'
import { MemberFace } from './MemberFace'
import { aiFailureKind, aiFailureText, failedOffline } from './AskSheet'
import { ActionCards, type CardHandlers } from './ChatCards'
import { useNow } from '../useNow'

// Chat: two threads that never mix (v3.26).
//
// Household is you and whoever you live with. Assistant is you and Drafter,
// asking it about your own planner. The owner asked for both and asked for
// them apart — "so our household chat is not being overtaken by the AI chat" —
// so they are separate records, separate threads and separate segments here.
// A household message is the household's by kind; an assistant turn is
// personal at the database, so the other member cannot read what you asked
// even if they wanted to.
//
// The assistant answers through exactly the machinery Ask already used:
// retrieval runs on this device, and only the couple of dozen records a
// question is about reach /api/ai, each under a made-up reference. It can
// suggest changes — a task, a meal, the shopping, a visit, a note, an event —
// each as a card under its answer (ChatCards.tsx), and nothing is written
// until one of them is tapped (src/chatactions.ts).
//
// Its words show as they arrive, in a bubble of their own where the answer
// will be. That bubble is only this screen's: the turn written, and synced, is
// the whole reply once it has been read and checked, and a reply that fails
// part way leaves nothing behind but the failure line and Try again.

export type ChatSide = 'household' | 'assistant'

/** Where an applied card's Open goes: the record, where it lives. */
export type ChatOpen = { kind: 'task' | 'note' | 'event'; id: string } | { kind: 'meal'; day: string } | { kind: 'grocery' }

/**
 * The planner as the assistant's cards reach it: the store and the shell's own
 * paths (ChatHost), the toast, the task and event editors, and the way out to
 * where a record lives. The chat screen builds it; without it the cards are
 * shown and cannot be pressed.
 */
export interface ChatShell extends ChatHost {
  toast(msg: string, undo?: () => void): void
  /** The task editor on a new task's preset; `done` runs once it saves. */
  editTask(preset: Partial<Task>, done: (t: Task) => void): void
  /** The event editor on an entry not saved yet; `done` runs once it saves. */
  editEvent(entry: CalendarEntry, done: (e: CalendarEntry) => void): void
  open(target: ChatOpen): void
  savePerson(p: Person): void
  savePlace(p: Place): void
  createPlace(name: string, kind: PlaceCategory): Place
}

/**
 * What this page can still undo, by card. A card's Undo and the toast's reach
 * the same one, and whichever is pressed first uses it up. Kept for the page,
 * as a toast's Undo is: after a reload an applied card shows ✓ and Open, and
 * what it made is taken back where it lives (the Trash, its editor).
 */
const undos = new Map<string, { undo(h: ChatHost): boolean; said: string }>()

/** A moment for the store's new copy to reach the next render, so the next suggestion is applied to the planner the last one left. */
const nextRender = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** Whether to land rather than travel: scrollTo's own smoothing ignores this. */
const stillWanted = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * What scrolls the thread. The chat's own section did while it was a sheet;
 * as a screen the page scrolls it, and scrolling a section that does not
 * scroll did nothing — a reply, and the suggestions under it, arrived below
 * the fold. So: the nearest box around the thread that does scroll, else the
 * page.
 */
function scrollerOf(pane: HTMLElement): HTMLElement {
  for (let box: HTMLElement | null = pane; box; box = box.parentElement) {
    const overflow = getComputedStyle(box).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && box.scrollHeight > box.clientHeight) return box
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/** Which speaker a line is drawn as: yours on the right, theirs on the left. */
const mine = (ownerId: string | undefined, myId: string | null) => !ownerId || !myId || ownerId === myId

/**
 * What the thread says under a question that got no answer, and whether Try
 * again can help: it can unless there is no assistant here at all. Offline is
 * said as offline, and a rate limit in the server's own words.
 */
function chatFailure(error: unknown): { text: string; retry: boolean } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    text: aiFailureText(message, { unavailable: 'The assistant isn’t available here.', failed: 'No answer came back' }),
    retry: failedOffline(message) || aiFailureKind(message) !== 'unavailable',
  }
}

function DayHead({ day }: { day: string }) {
  return (
    <li className="chat-day">
      <span>{dayLabel(day, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
    </li>
  )
}

/**
 * A composer: a growing box, Enter to send, Shift+Enter for a new line. While
 * an answer is on its way the box stays open to type the next question in —
 * disabling it would close the phone's keyboard — but Enter sends nothing, and
 * what is typed waits in the box.
 */
function Composer({
  placeholder,
  disabled,
  busy,
  onSend,
}: {
  placeholder: string
  disabled?: boolean
  busy?: boolean
  onSend(text: string): void
}) {
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const send = () => {
    const text = draft.trim()
    if (!text || disabled || busy) return
    setDraft('')
    onSend(text)
  }
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, as every chat does; a new line is still one Shift away
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }
  return (
    <div className="chat-composer">
      <textarea
        ref={box}
        rows={1}
        value={draft}
        maxLength={MESSAGE_MAX}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={key}
      />
      <button type="button" className="btn primary" disabled={disabled || busy || !draft.trim()} onClick={send}>
        {busy ? '…' : 'Send'}
      </button>
    </div>
  )
}

/** You and the people you live with. */
function HouseholdThread({
  messages,
  household,
  myId,
  onSend,
  onRemove,
}: {
  messages: Message[]
  household: HouseholdInfo | null
  myId: string | null
  onSend(body: string): void
  onRemove(id: string): void
}) {
  const [limit, setLimit] = useState(CHAT_PAGE)
  const shown = messages.slice(Math.max(0, messages.length - limit))
  const rows = thread(shown, m => m.ownerId ?? 'me')
  const inHousehold = (household?.members.length ?? 0) > 1

  return (
    <>
      {messages.length > shown.length && (
        <p className="chat-older">
          <button type="button" className="btn subtle" onClick={() => setLimit(n => n + CHAT_PAGE)}>
            Show older
          </button>
        </p>
      )}
      {messages.length === 0 ? (
        <p className="empty">
          {inHousehold
            ? 'Nothing said yet. This is for the two of you — what is happening today, who is picking up what, anything that is not a task.'
            : 'Nothing said yet. Once somebody else joins this planner (Settings → Household), this is where you talk to them.'}
        </p>
      ) : (
        <ul className="chat-thread">
          {rows.map(row =>
            'day' in row ? (
              <DayHead key={`d-${row.day}`} day={row.day} />
            ) : (
              <li key={row.item.id} className={mine(row.item.ownerId, myId) ? 'chat-line mine' : 'chat-line theirs'}>
                {row.firstOfRun && !mine(row.item.ownerId, myId) && (
                  <span className="chat-who">
                    <MemberFace
                      name={memberName(household, row.item.ownerId) ?? 'Household'}
                      avatar={household?.members.find(m => m.id === row.item.ownerId)?.avatar}
                      id={row.item.ownerId}
                      size={22}
                    />
                    {memberName(household, row.item.ownerId) ?? 'Household'}
                  </span>
                )}
                <span className="chat-bubble">
                  {row.item.body}
                  <time className="chat-at" dateTime={row.item.createdAt}>
                    {new Date(row.item.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </time>
                </span>
                {mine(row.item.ownerId, myId) && (
                  <button
                    type="button"
                    className="btn subtle chat-unsend"
                    aria-label="Delete this message"
                    title="Delete"
                    onClick={() => onRemove(row.item.id)}
                  >
                    ×
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {/* short enough for one line: at 375pt the iOS shell draws this at 16px in
          a 268px box, where the old "Say something to the household…" wrapped
          to two lines and the composer's 44pt floor cut the second one off */}
      <Composer placeholder="Message the household…" onSend={onSend} />
    </>
  )
}

/** The planner as the cards read it when there is no shell to write through: what the question was asked of. */
function dataOf(sources: AskSources): ChatData {
  return {
    people: sources.people,
    recipes: sources.recipes,
    places: sources.places,
    tasks: sources.tasks,
    meals: sources.meals,
    mealRows: sources.meals,
    groceries: [],
    notes: [],
    events: sources.entries,
    myId: null,
    inHousehold: false,
  }
}

/**
 * The model call: the question, what retrieval picked, the thread so far, and
 * what the reply is read against; `onText` hears the answer's words as they
 * arrive, for the screen alone.
 */
type Ask = (question: string, docs: AskDoc[], facts: string[], history: readonly string[], ctx: ChatActionContext, onText?: (shown: string) => void) => Promise<ChatReply>

/** Close enough to the foot of the thread to be following it down (px). */
const FOLLOWING = 160

/**
 * Whether the thread's newest line, the app's own lines aside, is a question:
 * its answer is still to come. An empty thread is waiting too, as far as it can
 * tell. Read off the thread rather than off `busy`: the store draws a turn the
 * moment it is written, and `busy` goes a render later, so for a frame the
 * answer and the words that became it were both on screen.
 */
function awaitingAnswer(turns: readonly ChatTurn[]): boolean {
  for (let i = turns.length - 1; i >= 0; i--) if (!turns[i].outcomes?.length) return turns[i].role === 'you'
  return true
}

/** You and Drafter, about your own planner. */
function AssistantThread({
  turns,
  sources,
  tz,
  shell,
  onWriteTurn,
  onOpen,
  onClear,
  ask,
  now,
}: {
  turns: ChatTurn[]
  sources: AskSources
  tz: string
  shell?: ChatShell
  onWriteTurn(t: ChatTurn): void
  onOpen(doc: AskDoc): void
  onClear(): void
  ask: Ask
  now?: Date
}) {
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [docs, setDocs] = useState<AskDoc[]>([])
  /** The answer's words so far, while it arrives: shown here, never written as a turn. */
  const [arriving, setArriving] = useState('')
  const arrivingLine = useRef<HTMLLIElement>(null)
  /** The last question that got no answer, said here and nowhere else: a failure is not a turn, and never syncs. */
  const [failed, setFailed] = useState<{ question: string; asked: ChatTurn | null; text: string; retry: boolean } | null>(null)
  /** The question in flight (askInThread): an Enter pressed again while it is out is the same question. */
  const asking = useRef(false)
  // the shell as of the latest render: an apply that waits a render between
  // suggestions, and a toast's Undo, both read the planner as it is by then
  const shellRef = useRef(shell)
  useLayoutEffect(() => {
    shellRef.current = shell
  })
  const clock = () => now ?? new Date()
  // today from the app's clock (useNow), not a reading as the thread draws:
  // the compiler would keep that first answer for as long as the chat is open
  const minute = useNow()
  const today = todayIn(tz, now ?? new Date(minute))
  const data = shell ?? dataOf(sources)
  const outcomes = outcomesByCard(turns)

  /**
   * Ask a question: it goes in the thread at once, and the answer under it when
   * it comes (askInThread). `asked` is a question already in the thread, asked
   * again by Try again.
   */
  const send = async (question: string, asked?: ChatTurn | null) => {
    const done = await askInThread({
      question,
      lock: asking,
      asked,
      write: onWriteTurn,
      ask: () => {
        setBusy(true)
        setFailed(null)
        setArriving('')
        // retrieval is local and instant: the records a question is about are
        // picked here, and only those go to the model
        const at = clock()
        const prep = prepareAsk(question, sources, { now: at, tz, includeJournal: false })
        setDocs(prep.docs)
        // a question asked again is already the last line of the thread: it is the question, not the conversation before it
        const history = recentContext(asked ? turns.filter(t => t.id !== asked.id) : turns)
        return ask(question, prep.docs, prep.facts, history, chatActionContext(prep.question, prep.docs, sources, { now: at, tz }), setArriving)
      },
    })
    // null: pressed again while the first was out, which is still being answered
    if (!done) return
    setBusy(false)
    setArriving('')
    if ('error' in done) setFailed({ question, asked: done.asked, ...chatFailure(done.error) })
  }

  // An answer arriving grows at the foot of the thread: it is followed down
  // there, unless the reader has scrolled up to read something else.
  useLayoutEffect(() => {
    const line = arrivingLine.current
    if (!line || !arriving) return
    const box = scrollerOf(line)
    if (box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOWING + line.offsetHeight) box.scrollTo({ top: box.scrollHeight })
  }, [arriving])

  /** A card's words as it was suggested, for the line that settles it. */
  const lineOf = (turn: ChatTurn, index: number) => {
    const action = turn.actions?.[index]
    return action ? describeAction(action, data, today).line : 'a suggestion'
  }

  /** The line the app writes when cards are applied, skipped or undone. It is what every device reads a card's state from. */
  const settle = (turnId: string, state: ChatOutcomeState, rows: { index: number; ids?: string[] }[], said: string[]) => {
    const line = newTurn('drafter', outcomeLine(state, said), undefined, new Date(), {
      outcomes: rows.map(r => ({ turnId, index: r.index, state, ...(r.ids?.length ? { ids: r.ids } : {}) })),
    })
    if (line) onWriteTurn(line)
  }

  /** Undo cards this page applied, newest first, each on the planner the last one left. */
  const undoApplied = async (turn: ChatTurn, indexes: number[]) => {
    const back: number[] = []
    let refused = 0
    const said: string[] = []
    for (const [i, index] of [...indexes].reverse().entries()) {
      const key = cardKey(turn.id, index)
      const held = undos.get(key)
      const h = shellRef.current
      if (!held || !h) continue
      if (held.undo(h)) {
        undos.delete(key)
        back.unshift(index)
        said.unshift(held.said)
      } else refused++
      if (i < indexes.length - 1) await nextRender()
    }
    if (refused) shellRef.current?.toast(refused === 1 ? 'That has changed since, so it was left as it is.' : `${refused} of them have changed since, so they were left as they are.`)
    if (back.length)
      settle(
        turn.id,
        'undone',
        back.map(index => ({ index })),
        said,
      )
  }

  /** Cards applied: remembered for Undo, settled in the thread, and said in the toast with its own Undo. */
  const record = (turn: ChatTurn, done: { index: number; applied: Applied }[]) => {
    const h = shellRef.current
    if (!done.length) {
      h?.toast('Nothing was changed: the planner has moved on since that was suggested.')
      return
    }
    for (const d of done) undos.set(cardKey(turn.id, d.index), { undo: d.applied.undo, said: d.applied.said })
    settle(
      turn.id,
      'applied',
      done.map(d => ({ index: d.index, ids: d.applied.ids })),
      done.map(d => d.applied.said),
    )
    h?.toast(done.length === 1 ? done[0].applied.said : `Applied ${done.length} changes`, () => void undoApplied(turn, done.map(d => d.index)))
  }

  // a second tap before the first has drawn is the same tap
  const applyingNow = useRef(false)
  const apply = async (turn: ChatTurn, items: { index: number; action: ChatAction }[]) => {
    if (applyingNow.current) return
    applyingNow.current = true
    setApplying(true)
    const done: { index: number; applied: Applied }[] = []
    const applyAll = async () => {
      for (const [i, item] of items.entries()) {
        const h = shellRef.current
        if (!h) break
        const at = new Date()
        const applied = applyChatAction(h, item.action, { turnId: turn.id, index: item.index, now: at, todayKey: todayIn(tz, at) })
        if (applied) done.push({ index: item.index, applied })
        // Apply all: the next card builds on what this one wrote (a second
        // grocery line on the list the first one changed), once it is here
        if (i < items.length - 1) await nextRender()
      }
    }
    // .finally rather than try/finally, which the React Compiler cannot compile
    await applyAll().finally(() => {
      applyingNow.current = false
      setApplying(false)
    })
    record(turn, done)
  }

  const handlersFor = (turn: ChatTurn): CardHandlers | undefined => {
    const h = shell
    if (!h) return undefined
    const removes = (id: string) => (host: ChatHost) => {
      host.remove(id)
      return true
    }
    return {
      apply: items => void apply(turn, items),
      skip: (index, action) => settle(turn.id, 'skipped', [{ index }], [describeAction(action, data, today).line]),
      undo: index => {
        if (cardState(outcomes.get(cardKey(turn.id, index))) === 'skipped') settle(turn.id, 'undone', [{ index }], [lineOf(turn, index)])
        else void undoApplied(turn, [index])
      },
      canUndo: index => undos.has(cardKey(turn.id, index)),
      edit: (index, action) => {
        // the app's own editors, opened on the suggestion; saving one is the apply
        if (action.type === 'create_task') {
          h.editTask(taskPreset(action, chatRecordId('task', turn.id, index)), t =>
            record(turn, [{ index, applied: { ids: [t.id], said: `Added task “${t.title || 'Untitled'}”`, undo: removes(t.id) } }]),
          )
        } else if (action.type === 'create_event') {
          h.editEvent(eventRecord(action, { id: chatRecordId('event', turn.id, index), now: new Date() }), e =>
            record(turn, [
              {
                index,
                applied: {
                  ids: [e.id],
                  said: `Added “${e.title}” to the calendar`,
                  undo: host => {
                    host.removeEvent(e.id)
                    return true
                  },
                },
              },
            ]),
          )
        }
      },
      saveNote: (index, note) => {
        h.upsert(note)
        record(turn, [{ index, applied: { ids: [note.id], said: `Added note “${note.title}”`, undo: removes(note.id) } }])
      },
      open: (_index, action, outcome) => {
        const id = outcome.ids?.[0]
        if (action.type === 'plan_meal') h.open({ kind: 'meal', day: action.date })
        else if (action.type === 'add_grocery') h.open({ kind: 'grocery' })
        else if (id) h.open({ kind: action.type === 'create_note' ? 'note' : action.type === 'create_event' ? 'event' : 'task', id })
      },
      savePerson: h.savePerson,
      savePlace: h.savePlace,
      createPlace: h.createPlace,
      createRecipe: h.createRecipe,
    }
  }

  const byRef = new Map(docs.map(d => [d.ref, d]))
  // the app's own lines are a speaker of their own, so an answer after one still says who it is from
  const rows = thread(turns, t => (t.outcomes?.length ? 'app' : t.role))
  // an answer on its way: its words, or the line that says it is coming, until the answer itself is in the thread
  const answerDue = busy && awaitingAnswer(turns)
  return (
    <>
      {turns.length === 0 ? (
        <div className="chat-intro">
          <p className="empty">
            Ask Drafter about your own week, or ask it to add or plan something. It reads your planner on this device and only sends the handful of records your
            question is about. It can suggest changes — nothing happens until you tap Apply.
          </p>
          <div className="chat-prompts">
            {CHAT_PROMPTS.map(p => (
              <button key={p} type="button" className="toggle" disabled={busy} onClick={() => void send(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ul className="chat-thread">
          {rows.map(row =>
            'day' in row ? (
              <DayHead key={`d-${row.day}`} day={row.day} />
            ) : row.item.outcomes?.length ? (
              // what the app wrote when a card was tapped: a quiet line, not a bubble
              <li key={row.item.id} className="chat-line theirs chat-outcome">
                <span className="chat-outcome-text">{row.item.text}</span>
              </li>
            ) : (
              <li key={row.item.id} className={row.item.role === 'you' ? 'chat-line mine' : row.item.actions?.length ? 'chat-line theirs drafter has-cards' : 'chat-line theirs drafter'}>
                {row.firstOfRun && row.item.role === 'drafter' && <span className="chat-who">✈ Drafter</span>}
                <span className="chat-bubble">
                  {row.item.text}
                  {(row.item.cites ?? []).length > 0 && (
                    <span className="chat-cites">
                      {(row.item.cites ?? []).map(ref => {
                        const doc = byRef.get(ref)
                        return doc ? (
                          <button key={ref} type="button" className="toggle" onClick={() => onOpen(doc)}>
                            {doc.title || ref}
                          </button>
                        ) : (
                          <span key={ref} className="toggle" title="From an earlier answer — open it from the record itself">
                            {ref}
                          </span>
                        )
                      })}
                    </span>
                  )}
                </span>
                {row.item.role === 'drafter' && (row.item.actions?.length ?? 0) > 0 && (
                  <ActionCards turn={row.item} outcomes={outcomes} data={data} todayKey={today} busy={busy || applying} on={handlersFor(row.item)} />
                )}
              </li>
            ),
          )}
          {answerDue && arriving && (
            // where the answer will be, drawn as it will be drawn: the turn replaces it once the whole reply is read
            <li ref={arrivingLine} className="chat-line theirs drafter chat-arriving" aria-busy="true">
              <span className="chat-who">✈ Drafter</span>
              <span className="chat-bubble">{arriving}</span>
            </li>
          )}
        </ul>
      )}
      {answerDue && !(arriving && turns.length > 0) && <p className="chat-thinking">Reading your planner…</p>}
      {failed && !busy && (
        <p className="chat-thinking ask-failed" role="status">
          {failed.text}{' '}
          {failed.retry && (
            <button type="button" className="btn subtle" onClick={() => void send(failed.question, failed.asked)}>
              Try again
            </button>
          )}
        </p>
      )}
      <Composer placeholder="Ask about your week…" busy={busy} onSend={q => void send(q)} />
      {turns.length > 0 && (
        <p className="chat-older">
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              setFailed(null)
              onClear()
            }}
          >
            Clear this conversation
          </button>
        </p>
      )}
    </>
  )
}

interface Props {
  side: ChatSide
  onSide(side: ChatSide): void
  /**
   * The household thread is on screen: everything written up to `at` has been
   * shown. The shell keeps the mark (per device), so the badge on Home clears
   * by reading rather than on a timer.
   */
  onSeen?(at: string): void
  messages: Message[]
  turns: ChatTurn[]
  household: HouseholdInfo | null
  myId: string | null
  sources: AskSources
  tz: string
  onSendMessage(m: Message): void
  onRemoveMessage(id: string): void
  onWriteTurn(t: ChatTurn): void
  onClearChat(ids: string[]): void
  onOpen(doc: AskDoc): void
  /** What the assistant's suggestions are applied through. Without it they are shown, and cannot be pressed. */
  shell?: ChatShell
  /** The model call. Defaults to the one /api/ai request; the tests pass their own. */
  ask?: Ask
  now?: Date
}

export function Chat({
  side,
  onSide,
  onSeen,
  messages,
  turns,
  household,
  myId,
  sources,
  tz,
  onSendMessage,
  onRemoveMessage,
  onWriteTurn,
  onClearChat,
  onOpen,
  shell,
  ask = askWithActions,
  now,
}: Props) {
  const pane = useRef<HTMLElement>(null)
  /*
   * A thread you have just added to belongs at the bottom, the way every chat
   * does — but WHICH box moves matters, and so does when.
   *
   * This used to ask a marker at the end of the section to bring itself into
   * view. scrollIntoView walks up to the nearest thing that scrolls, and the
   * sheet had nothing: it reached the backdrop, so the whole panel lurched,
   * and it ran in an effect, which is after the browser has painted — you saw
   * the thread from the top and then it jumped. Scrolling the one box that
   * scrolls the thread (scrollerOf) moves nothing else, and a layout effect
   * puts the first frame where it belongs, so there is nothing left to see jump.
   */
  const shown = useRef<ChatSide | null>(null)
  useLayoutEffect(() => {
    const el = pane.current ? scrollerOf(pane.current) : null
    if (!el) return
    // opening, and switching threads, LAND at the bottom; a message arriving
    // while you are reading travels there, so you can see that it did
    const jump = shown.current !== side || stillWanted()
    shown.current = side
    el.scrollTo({ top: el.scrollHeight, behavior: jump ? 'auto' : 'smooth' })
  }, [side, messages.length, turns.length])
  // The page scrolls the chat, so leaving it — Back, a tab, a card's Open —
  // would leave the next screen as far down as the thread was. It starts at
  // its top instead, before it is painted. And whatever mounts the chat
  // again (React's development double mount among them) is opening it, which
  // lands at the bottom rather than travelling there.
  useLayoutEffect(
    () => () => {
      shown.current = null
      ;(document.scrollingElement ?? document.documentElement).scrollTo({ top: 0 })
    },
    [],
  )
  // drawing the household thread IS reading it
  const newest = messages[messages.length - 1]?.createdAt
  useEffect(() => {
    if (side === 'household' && newest) onSeen?.(newest)
  }, [side, newest, onSeen])

  return (
    <section className="chat" ref={pane}>
      {/* The tab-level track People · Places uses, so the two halves of the
          chat read as one control rather than as two small web buttons; the
          native shell draws it as an iOS segmented control (19-native-shell). */}
      <div className="people-tab-seg chat-seg">
        <span className="segmented" role="tablist" aria-label="Which chat">
          <button type="button" role="tab" aria-selected={side === 'household'} className={side === 'household' ? 'seg on' : 'seg'} onClick={() => onSide('household')}>
            Household
          </button>
          <button type="button" role="tab" aria-selected={side === 'assistant'} className={side === 'assistant' ? 'seg on' : 'seg'} onClick={() => onSide('assistant')}>
            Assistant
          </button>
        </span>
      </div>
      {/* one quiet line, not a heading and a paragraph: a chat screen's job is
          the thread and the box you type in */}
      <p className="chat-what">
        {side === 'household' ? 'You and the people you live with.' : 'Only you can read this. Nothing changes until you tap Apply.'}
      </p>

      {side === 'household' ? (
        <HouseholdThread
          messages={messages}
          household={household}
          myId={myId}
          onSend={body => {
            const m = newMessage(body)
            if (m) onSendMessage(m)
          }}
          onRemove={onRemoveMessage}
        />
      ) : (
        <AssistantThread
          turns={turns}
          sources={sources}
          tz={tz}
          shell={shell}
          ask={ask}
          now={now}
          onOpen={onOpen}
          onClear={() => onClearChat(turns.map(t => t.id))}
          onWriteTurn={onWriteTurn}
        />
      )}
    </section>
  )
}
