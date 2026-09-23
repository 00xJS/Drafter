// Rules about talking to a model that the app and the server both need, so
// there is one copy and not two. The app calls these from src/ai.ts; the
// server from netlify/functions/lib/ai.mjs (every NVIDIA answer) and the
// Sunday digest from netlify/functions/digest.mjs.

/** Words long enough that an answer never repeats a run of them by accident. */
const ECHO_RUN = 6

const flatten = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * A reasoning model's thinking, out of its text. Models tag it `<think>`,
 * `<thinking>` or `<reasoning>`, and some NIM builds `◁think▷`. Three shapes
 * reach here: a closed block; a close with no open, when the chat template
 * opened the block in the prompt and the model only ever wrote `</think>`;
 * and an open that never closed, when the budget ran out mid-thought. The
 * server used to know only the first and the last, so a lone `</think>` came
 * through with all the reasoning before it, and only the chat, which had its
 * own copy of this, took it out.
 *
 * Untagged thinking is the other half, and no rule here sees it; that is
 * `looksLikeThinking`, where the answer is read.
 */
export function stripThinking(text: unknown): string {
  return String(text ?? '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/◁(think|thinking)▷[\s\S]*?◁\/\1▷/g, '')
    .replace(/^[\s\S]*?<\/(think|thinking|reasoning)>/i, '')
    .replace(/^[\s\S]*?◁\/(think|thinking)▷/, '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '')
    .replace(/◁(think|thinking)▷[\s\S]*$/, '')
    .trim()
}

/**
 * Whether a plain-text reply is the model thinking rather than answering.
 *
 * A reasoning model restates its brief before it works — "We need to produce a
 * personal review, warm, candid… no headings… 120-220 words" — and when the
 * budget runs out there, that is what comes back. It is prose, so nothing about
 * its shape gives it away; what gives it away is that it quotes the
 * instructions, which an answer has no reason to do. So: flatten both, and look
 * for any run of six words from the brief inside the reply.
 *
 * Untagged thinking that quotes nothing gets through, and should: a rule loose
 * enough to catch it would throw away real answers.
 */
export function looksLikeThinking(text: string, system: string): boolean {
  const said = flatten(text)
  const brief = flatten(system).split(' ')
  if (!said || brief.length < ECHO_RUN) return false
  for (let i = 0; i + ECHO_RUN <= brief.length; i++) {
    if (said.includes(brief.slice(i, i + ECHO_RUN).join(' '))) return true
  }
  return false
}

/** Appended to a brief when a first answer came back as thinking. */
export const NO_THINKING = 'Reply with the finished text only — no reasoning, no commentary, and do not restate these instructions.'

/** Appended to a brief when a first JSON answer came back cut off, empty or the wrong shape. */
export const JSON_ONLY = 'Reply with the JSON only — no reasoning and no commentary.'

/**
 * The brief for a period's review, written once for both the ✨ button and the
 * Sunday draft the server writes on its own.
 *
 * Worded so that nothing in it is a phrase the review itself would use:
 * `looksLikeThinking` works by spotting the brief quoted back, and a brief that
 * says "the two or three things that matter most next" invites the review to
 * say exactly that and be sent back for it.
 */
export const REVIEW_SYSTEM =
  'You are writing someone their own review of the period, in the second person: warm, candid, a good friend who is also organised. Name the tasks and the people. Say what went well, say plainly what slipped, and finish by naming the few things worth doing first. Where their journal explains how the period went, use their own words for it. Use only what is below — invent nothing, and leave out anything they did not do.\n\nPlain prose in short paragraphs, with "-" bullets where a list reads better. No headings, no bold, no italics. Write only the review.'
