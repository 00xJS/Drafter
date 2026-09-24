import { prepareAsk, type AskSources } from './ask'
import { CHAT_HELP } from './assistanthelp'
import { askWithActions, chatActionContext, type ChatReply } from './chatactions'
import type { ChatAction } from './types'

// The assistant's kinds of answer, checked against the real model.
//
// The chat is shaped by what it is told, not trained: "What can you do?" came
// back as "not in the records" because nothing it was told said otherwise. So
// each kind of answer that matters has a question here, asked of the real
// model with nothing from anyone's planner (Admin → AI assist → Check the
// assistant), and the check says which came back as they should. A new kind
// of answer gets a case here, and a rule in buildChatPrompt.

/** What a reply should be: the help text, an answer about itself, general knowledge, small talk, "the planner doesn't say", or a suggested change. */
export type AnswerKind = 'help' | 'about' | 'general' | 'chat' | 'unknown' | ChatAction['type']

export interface EvalCase {
  /** The kind of answer, as Admin lists it. */
  label: string
  question: string
  expect: AnswerKind
}

export const CHAT_EVAL: EvalCase[] = [
  { label: 'What it can do', question: 'What all can you do?', expect: 'help' },
  { label: 'Something it can’t do', question: 'Can you text Maria for me?', expect: 'about' },
  { label: 'How to use it', question: 'How do I add things to the grocery list?', expect: 'about' },
  { label: 'A general question', question: 'How long should I grill a steak for medium rare?', expect: 'general' },
  { label: 'Thanks', question: 'Thanks, that was really helpful!', expect: 'chat' },
  { label: 'Not in your planner', question: 'What did I have for dinner on New Year’s Day?', expect: 'unknown' },
  { label: 'A change: the shopping', question: 'Add milk and eggs to the grocery list', expect: 'add_grocery' },
  { label: 'A change: a task', question: 'Remind me to call the bank on Friday', expect: 'create_task' },
]

export interface EvalResult {
  case: EvalCase
  pass: boolean
  /** Why it failed, or what it did right, in a few words. */
  why: string
  answer: string
  /** How long after asking the answer's first words showed (ms); none when no words streamed — the help text, or a call that failed first. */
  firstTextMs?: number
  /** How long after asking the whole answer was read, or the call failed (ms). */
  totalMs: number
}

/** "Not in the records" and its cousins: right when the planner can't answer, wrong for anything else. */
const NOT_IN_RECORDS =
  /\b(?:(?:is|are)(?:n['’]t| not) in (?:the|your) (?:records|planner)|not in (?:the|your) (?:records|planner)|(?:don['’]t|do not) (?:have|see) (?:that|this|any) (?:information|info)|no (?:information|record|records) (?:about|on|of|for))\b/i

const SUGGESTION: Partial<Record<ChatAction['type'], string>> = {
  add_grocery: 'a grocery suggestion',
  create_task: 'a task suggestion',
  plan_meal: 'a meal suggestion',
  create_note: 'a note suggestion',
  create_event: 'an event suggestion',
  log_visit: 'a visit suggestion',
  update_task: 'a change to a task',
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** Whether a reply is the kind of answer its case wants, and why not when it isn't. */
export function judgeReply(c: EvalCase, r: ChatReply): { pass: boolean; why: string } {
  const refused = NOT_IN_RECORDS.test(r.answer)
  switch (c.expect) {
    case 'help':
      return r.answer === CHAT_HELP ? { pass: true, why: 'the help text, with no model call' } : { pass: false, why: 'went to the model instead of the help text' }
    case 'about':
      if (refused) return { pass: false, why: 'said the records don’t hold it' }
      if (r.general) return { pass: false, why: 'answered about itself as general knowledge' }
      return { pass: true, why: 'answered about itself' }
    case 'general':
      if (refused) return { pass: false, why: 'said the records don’t hold it' }
      if (!r.general) return { pass: false, why: 'not marked as general' }
      return { pass: true, why: 'answered and marked as general' }
    case 'chat':
      if (refused) return { pass: false, why: 'said the records don’t hold it' }
      if (r.actions.length) return { pass: false, why: 'suggested a change to a thank-you' }
      if (words(r.answer) > 40) return { pass: false, why: `${words(r.answer)} words for a thank-you` }
      return { pass: true, why: 'a short reply' }
    case 'unknown':
      if (r.general) return { pass: false, why: 'made up an answer from general knowledge' }
      if (r.actions.length) return { pass: false, why: 'suggested a change instead of answering' }
      return { pass: true, why: 'said the planner doesn’t show it' }
    default: {
      const wanted = SUGGESTION[c.expect] ?? c.expect
      return r.actions.some(a => a.type === c.expect) ? { pass: true, why: `offered ${wanted}` } : { pass: false, why: `no ${wanted.replace(/^an? /, '')}` }
    }
  }
}

/** Seconds, to a tenth: "1.4 s". */
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** How long a case took, as Admin says it: when its first words showed and when the answer was whole, or only the latter when nothing streamed. */
export function timingLine(r: Pick<EvalResult, 'firstTextMs' | 'totalMs'>): string {
  return r.firstTextMs === undefined ? `answered in ${seconds(r.totalMs)}` : `first words ${seconds(r.firstTextMs)} · whole answer ${seconds(r.totalMs)}`
}

/**
 * The check's speed in one line, over the cases the model answered: how soon
 * words showed and how long an answer took, on average. Empty when none did.
 */
export function speedLine(results: readonly (EvalResult | undefined)[]): string {
  const asked = results.filter((r): r is EvalResult => !!r && r.firstTextMs !== undefined)
  if (!asked.length) return ''
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  return `On average the first words showed after ${seconds(mean(asked.map(r => r.firstTextMs!)))}, and the whole answer took ${seconds(mean(asked.map(r => r.totalMs)))}.`
}

/** Nothing from anyone's planner: the check is about the assistant, and sends no records. */
const NOTHING: AskSources = { tasks: [], projects: [], people: [], places: [], recipes: [], meals: [], entries: [], feedEvents: [], journal: [] }

/**
 * Ask every case, two at a time — each is one call to the real model, and the
 * AI endpoint allows each person 30 in ten minutes — and judge each reply as it
 * lands. A call that fails is a failed case, not a failed check. Each is timed
 * as the chat is felt: until its first words show, and until the whole answer
 * is read.
 */
export async function runChatEval(
  o: { now?: Date; tz?: string; ask?: typeof askWithActions; onResult?(result: EvalResult, index: number): void } = {},
): Promise<EvalResult[]> {
  const now = o.now ?? new Date()
  const tz = o.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const ask = o.ask ?? askWithActions
  const results: EvalResult[] = []
  let next = 0
  const worker = async () => {
    while (next < CHAT_EVAL.length) {
      const index = next++
      const c = CHAT_EVAL[index]
      const prep = prepareAsk(c.question, NOTHING, { now, tz, includeJournal: false })
      const started = Date.now()
      const timing: { firstTextMs?: number } = {}
      const shown = (text: string) => {
        if (text && timing.firstTextMs === undefined) timing.firstTextMs = Date.now() - started
      }
      let result: EvalResult
      try {
        const reply = await ask(c.question, prep.docs, prep.facts, [], chatActionContext(prep.question, prep.docs, NOTHING, { now, tz }), shown)
        result = { case: c, answer: reply.answer, ...judgeReply(c, reply), ...timing, totalMs: Date.now() - started }
      } catch (e) {
        result = { case: c, answer: '', pass: false, why: `no answer: ${(e as Error).message}`, ...timing, totalMs: Date.now() - started }
      }
      results[index] = result
      o.onResult?.(result, index)
    }
  }
  await Promise.all([worker(), worker()])
  return results
}
