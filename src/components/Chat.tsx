import { KeyboardEvent, useEffect, useRef, useState } from 'react'
import { askDrafter } from '../ai'
import { CHAT_PAGE, CHAT_PROMPTS, newMessage, newTurn, recentContext, thread } from '../chat'
import { dayLabel } from '../journal'
import { memberName, type HouseholdInfo } from '../household'
import { AskDoc, AskSources, prepareAsk } from '../ask'
import { MESSAGE_MAX, type ChatTurn, type Message } from '../types'
import { MemberFace } from './MemberFace'
import { askFailure } from './AskSheet'

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
// question is about reach /api/ai, each under a made-up reference. It cannot
// write anything.

export type ChatSide = 'household' | 'assistant'

/** Which speaker a line is drawn as: yours on the right, theirs on the left. */
const mine = (ownerId: string | undefined, myId: string | null) => !ownerId || !myId || ownerId === myId

function DayHead({ day }: { day: string }) {
  return (
    <li className="chat-day">
      <span>{dayLabel(day, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
    </li>
  )
}

/** A composer: a growing box, Enter to send, Shift+Enter for a new line. */
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
    if (!text) return
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
      <Composer placeholder="Say something to the household…" onSend={onSend} />
    </>
  )
}

/** You and Drafter, about your own planner. */
function AssistantThread({
  turns,
  sources,
  tz,
  onAsk,
  onOpen,
  onClear,
  ask,
  now,
}: {
  turns: ChatTurn[]
  sources: AskSources
  tz: string
  onAsk(you: string, answer: string | null, cites: string[], failure?: string): void
  onOpen(doc: AskDoc): void
  onClear(): void
  ask(question: string, docs: AskDoc[], facts: string[], history: readonly string[]): Promise<{ answer: string; cites: string[] }>
  now?: Date
}) {
  const [busy, setBusy] = useState(false)
  const [docs, setDocs] = useState<AskDoc[]>([])

  const send = async (question: string) => {
    setBusy(true)
    // retrieval is local and instant: the records a question is about are
    // picked here, and only those go to the model
    const prep = prepareAsk(question, sources, { now: now ?? new Date(), tz, includeJournal: false })
    setDocs(prep.docs)
    const history = recentContext(turns)
    try {
      const r = await ask(question, prep.docs, prep.facts, history)
      onAsk(question, r.answer, r.cites)
    } catch (e) {
      onAsk(question, null, [], askFailure((e as Error).message).text)
    } finally {
      setBusy(false)
    }
  }

  const byRef = new Map(docs.map(d => [d.ref, d]))
  const rows = thread(turns, t => t.role)
  return (
    <>
      {turns.length === 0 ? (
        <div className="chat-intro">
          <p className="empty">
            Ask Drafter about your own week. It reads your planner on this device and only sends the handful of records your question is about — and it cannot change
            anything.
          </p>
          <div className="platform-toggles">
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
            ) : (
              <li key={row.item.id} className={row.item.role === 'you' ? 'chat-line mine' : 'chat-line theirs drafter'}>
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
              </li>
            ),
          )}
        </ul>
      )}
      {busy && <p className="chat-thinking">Reading your planner…</p>}
      <Composer placeholder="Ask about your week…" busy={busy} onSend={q => void send(q)} />
      {turns.length > 0 && (
        <p className="chat-older">
          <button type="button" className="btn subtle" onClick={onClear}>
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
  /** The model call. Defaults to the one /api/ai request; the tests pass their own. */
  ask?(question: string, docs: AskDoc[], facts: string[], history: readonly string[]): Promise<{ answer: string; cites: string[] }>
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
  ask = askDrafter,
  now,
}: Props) {
  const foot = useRef<HTMLDivElement>(null)
  // a thread you have just added to belongs at the bottom, the way every chat does
  useEffect(() => {
    foot.current?.scrollIntoView({ block: 'end' })
  }, [side, messages.length, turns.length])
  // drawing the household thread IS reading it
  const newest = messages[messages.length - 1]?.createdAt
  useEffect(() => {
    if (side === 'household' && newest) onSeen?.(newest)
  }, [side, newest, onSeen])

  return (
    <section className="chat">
      <div className="toolbar people-toolbar">
        <div>
          <h2 className="view-title">Chat</h2>
          <p className="chart-sub">
            {side === 'household' ? 'You and the people you live with.' : 'You and Drafter, about your own planner. Nobody else can read this.'}
          </p>
        </div>
      </div>

      <div className="list-stats-bar">
        <span className="segmented list-stats-seg" role="tablist" aria-label="Which chat">
          <button type="button" role="tab" aria-selected={side === 'household'} className={side === 'household' ? 'seg on' : 'seg'} onClick={() => onSide('household')}>
            Household
          </button>
          <button type="button" role="tab" aria-selected={side === 'assistant'} className={side === 'assistant' ? 'seg on' : 'seg'} onClick={() => onSide('assistant')}>
            Assistant
          </button>
        </span>
      </div>

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
          ask={ask}
          now={now}
          onOpen={onOpen}
          onClear={() => onClearChat(turns.map(t => t.id))}
          onAsk={(you, answer, cites, failure) => {
            // The thread sorts on the id, and the id starts with the instant.
            // Both turns are written in one go, so the answer is stamped a
            // millisecond later — two rows in the same millisecond would fall
            // back to their random suffix and the answer could come first.
            const at = new Date()
            const asked = newTurn('you', you, undefined, at)
            if (asked) onWriteTurn(asked)
            const said = newTurn('drafter', answer ?? failure ?? 'No answer came back.', cites, new Date(at.getTime() + 1))
            if (said) onWriteTurn(said)
          }}
        />
      )}
      <div ref={foot} />
    </section>
  )
}
