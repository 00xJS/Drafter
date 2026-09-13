import { useEffect, useRef, useState } from 'react'
import { AskDoc, AskKind, AskPrep, AskSources, parseAskAnswer, prepareAsk } from '../ask'
import { askDrafter } from '../ai'
import { relativeDayLabel } from '../journal'
import { excerpt } from '../utils'
import { Modal, ModalHead } from './Modal'

// Ask Drafter: a question answered from your own planner. Retrieval runs on the
// device and its sources show at once, so the sheet is useful even when the
// model is busy or not there at all; the one /api/ai call only writes the
// answer, and a reference it invents never becomes a chip (src/ask.ts).

/** Whether Ask may read the journal: off until turned on, and remembered. */
export const ASK_JOURNAL_KEY = 'drafter:ask-journal'

export const ASK_KIND_META: Record<AskKind, { emoji: string; label: string }> = {
  task: { emoji: '☐', label: 'Task' },
  bill: { emoji: '🧾', label: 'Bill' },
  project: { emoji: '📁', label: 'Project' },
  person: { emoji: '👤', label: 'Person' },
  place: { emoji: '📍', label: 'Place' },
  recipe: { emoji: '🍲', label: 'Recipe' },
  meal: { emoji: '🍽️', label: 'Meal' },
  event: { emoji: '📅', label: 'Event' },
  journal: { emoji: '📓', label: 'Journal' },
}

/** Sources listed before "Show all". */
const SOURCES_SHOWN = 6

export function readAskJournal(): boolean {
  try {
    return localStorage.getItem(ASK_JOURNAL_KEY) === '1'
  } catch {
    return false
  }
}

function writeAskJournal(on: boolean) {
  try {
    localStorage.setItem(ASK_JOURNAL_KEY, on ? '1' : '0')
  } catch {
    /* private mode: the chip still works for this sheet */
  }
}

/**
 * Why an /api/ai call failed, as far as a sheet needs to know: the account is
 * over its rate (429), the assistant is not there at all (501 with no provider
 * key, offline, or local mode with no API), or anything else.
 */
export function aiFailureKind(message: string): 'busy' | 'unavailable' | 'other' {
  if (/too many|\b429\b|rate.?limit|busy/i.test(message)) return 'busy'
  if (/unreachable|hosted site|netlify dev|\b501\b|not configured|no ai provider|api_key|offline|failed to fetch|network/i.test(message)) return 'unavailable'
  return 'other'
}

/** What Ask says when no answer came. Unavailable is not an error here: the sources are the answer. */
export function askFailure(message: string): { text: string; retry: boolean } {
  const kind = aiFailureKind(message)
  if (kind === 'busy') return { text: 'Drafter’s assistant is busy — try again in a minute.', retry: true }
  if (kind === 'unavailable') return { text: 'The assistant isn’t available here, so there’s no written answer — these are the records that match.', retry: false }
  return { text: `Couldn’t write an answer: ${message}`, retry: true }
}

/** Only worth a model call when something matched; the facts alone are just today's date. */
const worthAsking = (prep: AskPrep) => prep.docs.length > 0 || prep.facts.length > 1

interface Request {
  id: number
  question: string
  prep: AskPrep
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'empty' }
  | { kind: 'answered'; parts: (string | AskDoc)[]; also: AskDoc[] }
  | { kind: 'failed'; text: string; retry: boolean }

type Answer = { answer: string; cites: string[] }

interface Props {
  /** From the palette's "Ask Drafter: “…”" row: asked as soon as the sheet opens. Empty from the palette command. */
  initialQuestion?: string
  sources: AskSources
  tz: string
  /** A source or a citation was tapped: route it by kind (the sheet stays as it is). */
  onOpen(doc: AskDoc): void
  onClose(): void
  /** The model call. Defaults to askDrafter's one /api/ai request; tests pass their own. */
  ask?(question: string, docs: AskDoc[], facts: string[]): Promise<Answer>
  /** The moment the question is asked about. Defaults to now. */
  now?: Date
}

export function AskSheet({ initialQuestion = '', sources, tz, onOpen, onClose, ask = askDrafter, now }: Props) {
  const [draft, setDraft] = useState(initialQuestion)
  const [journal, setJournal] = useState(readAskJournal)
  const [all, setAll] = useState(false)
  const prepare = (question: string, includeJournal: boolean) => prepareAsk(question, sources, { now: now ?? new Date(), tz, includeJournal })
  // the sources are worked out in the first render, so they are on screen
  // before any answer — and without one
  const [req, setReq] = useState<Request | null>(() => {
    const question = initialQuestion.trim()
    return question ? { id: 1, question, prep: prepare(question, journal) } : null
  })
  const [phase, setPhase] = useState<Phase>(() => (!req ? { kind: 'idle' } : worthAsking(req.prep) ? { kind: 'busy' } : { kind: 'empty' }))
  const askRef = useRef(ask)
  askRef.current = ask
  // one call per question: StrictMode's rehearsal re-runs the effect, not the request
  const inflight = useRef<{ id: number; answer: Promise<Answer> } | null>(null)

  useEffect(() => {
    if (!req) return
    if (!worthAsking(req.prep)) {
      setPhase({ kind: 'empty' })
      return
    }
    if (inflight.current?.id !== req.id) inflight.current = { id: req.id, answer: askRef.current(req.question, req.prep.docs, req.prep.facts) }
    const pending = inflight.current.answer
    let live = true
    setPhase({ kind: 'busy' })
    pending.then(
      res => {
        if (!live) return
        const { parts, cites } = parseAskAnswer(res.answer, req.prep.docs)
        const inline = new Set(cites.map(d => d.ref))
        const also = res.cites.map(ref => req.prep.docs.find(d => d.ref === ref)).filter((d): d is AskDoc => !!d && !inline.has(d.ref))
        setPhase({ kind: 'answered', parts, also })
      },
      (e: unknown) => {
        if (live) setPhase({ kind: 'failed', ...askFailure(e instanceof Error ? e.message : String(e)) })
      },
    )
    return () => {
      live = false
    }
  }, [req])

  const submit = () => {
    const question = draft.trim()
    if (!question) return
    setAll(false)
    setReq(r => ({ id: (r?.id ?? 0) + 1, question, prep: prepare(question, journal) }))
  }

  // the chip changes what may be read, so the question is asked again with it
  const toggleJournal = () => {
    const next = !journal
    setJournal(next)
    writeAskJournal(next)
    if (req) setReq({ id: req.id + 1, question: req.question, prep: prepare(req.question, next) })
  }

  const docs = req?.prep.docs ?? []
  const cited = new Set(
    phase.kind === 'answered' ? [...phase.parts.filter((p): p is AskDoc => typeof p !== 'string'), ...phase.also].map(d => d.ref) : [],
  )
  const shown = all ? docs : docs.slice(0, SOURCES_SHOWN)

  return (
    <Modal onClose={onClose} className="modal ask-sheet">
      <ModalHead title="✨ Ask Drafter" />
      <div className="modal-body">
        <form
          className="ask-form"
          onSubmit={e => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            className="ask-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="When did I last see Mum? What did we eat last week?"
            aria-label="Your question"
            enterKeyHint="search"
            maxLength={500}
            autoFocus={!initialQuestion.trim()}
          />
          <button type="submit" className="btn primary" disabled={!draft.trim() || phase.kind === 'busy'}>
            Ask
          </button>
        </form>
        <div className="ask-chips">
          <button type="button" className={journal ? 'toggle on' : 'toggle'} aria-pressed={journal} onClick={toggleJournal}>
            📓 Journal
          </button>
          <small className="ask-note">{journal ? 'Your journal entries are searched too.' : 'Journal off: your entries stay out of it.'}</small>
        </div>

        {req?.prep.journalHint && (
          <p className="ask-note ask-hint">
            Turn on Journal to search your entries.{' '}
            <button type="button" className="btn subtle" onClick={toggleJournal}>
              Turn on
            </button>
          </p>
        )}

        {req && (
          <section className="ask-answer-wrap" aria-live="polite">
            {phase.kind === 'busy' && <p className="ask-note">Reading your planner…</p>}
            {phase.kind === 'empty' && <p className="ask-note">Nothing in your planner matches that.</p>}
            {phase.kind === 'failed' && (
              <p className="ask-note ask-failed">
                {phase.text}{' '}
                {phase.retry && (
                  <button type="button" className="btn subtle" onClick={() => setReq({ ...req, id: req.id + 1 })}>
                    Try again
                  </button>
                )}
              </p>
            )}
            {phase.kind === 'answered' && (
              <>
                <p className="ask-answer">
                  {phase.parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <Cite key={i} doc={p} onOpen={onOpen} />))}
                </p>
                {phase.also.length > 0 && (
                  <p className="ask-also">
                    <small>Also from</small> {phase.also.map(d => <Cite key={d.ref} doc={d} onOpen={onOpen} />)}
                  </p>
                )}
              </>
            )}
          </section>
        )}

        {req && docs.length > 0 && (
          <section className="ask-sources-wrap" aria-label="Sources">
            <h3 className="ask-sources-head">
              Sources <small>{docs.length}</small>
            </h3>
            <ul className="ask-sources">
              {shown.map(doc => (
                <li key={doc.ref}>
                  <button type="button" className={cited.has(doc.ref) ? 'ask-source cited' : 'ask-source'} onClick={() => onOpen(doc)}>
                    <span className="ask-kind" aria-hidden>
                      {ASK_KIND_META[doc.kind].emoji}
                    </span>
                    <span className="ask-source-main">
                      {doc.title}
                      <small>
                        {ASK_KIND_META[doc.kind].label}
                        {doc.date ? ` · ${relativeDayLabel(doc.date)}` : ''}
                        {cited.has(doc.ref) ? ' · cited' : ''}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {docs.length > SOURCES_SHOWN && (
              <button type="button" className="btn subtle" onClick={() => setAll(a => !a)}>
                {all ? 'Show fewer' : `Show all ${docs.length}`}
              </button>
            )}
          </section>
        )}

        <p className="ask-note ask-privacy">
          Only the matching records go to the assistant — never a location, a contact detail or a real id, and the journal only with the chip on.
        </p>
      </div>
    </Modal>
  )
}

/** A citation: the record it rests on, as a chip that opens it. */
function Cite({ doc, onOpen }: { doc: AskDoc; onOpen(doc: AskDoc): void }) {
  return (
    <button type="button" className="ask-cite" onClick={() => onOpen(doc)} title={`Open ${doc.title}`}>
      <span aria-hidden>{ASK_KIND_META[doc.kind].emoji}</span> {excerpt(doc.title, 32)}
    </button>
  )
}
