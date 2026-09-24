// Rules about talking to a model that the app and the server both need, so
// there is one copy and not two. The app calls these from src/ai.ts and
// src/chatactions.ts; the server from netlify/functions/lib/ai.mjs (every
// NVIDIA answer) and from the work it does by itself — Sunday's review draft
// and email-in's triage (netlify/functions/lib/sundaydraft.mjs, lib/triage.mjs).

/** Words long enough that an answer never repeats a run of them by accident. */
const ECHO_RUN = 6

// "isn't" is one word, not "isn" and "t": counted as two, a contraction made
// an ordinary five-word phrase long enough to read as the brief quoted back
const flatten = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
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

/** The tags stripThinking takes out: angle-bracket ones in any case, NIM's triangle ones as written. */
const ANGLE_TAG = /<(\/?)(think|thinking|reasoning)>/i
const TRIANGLE_TAG = /◁(\/?)(think|thinking)▷/
const TAG_TEXTS = [
  ...['think', 'thinking', 'reasoning'].flatMap(n => [`<${n}>`, `</${n}>`]),
  ...['think', 'thinking'].flatMap(n => [`◁${n}▷`, `◁/${n}▷`]),
]

type Style = 'angle' | 'triangle'

/** The first whole tag in `s`, if there is one. */
function firstTag(s: string): { at: number; length: number; name: string; close: boolean; style: Style } | null {
  const angle = ANGLE_TAG.exec(s)
  const triangle = TRIANGLE_TAG.exec(s)
  const [m, style] = angle && (!triangle || angle.index <= triangle.index) ? [angle, 'angle' as const] : triangle ? [triangle, 'triangle' as const] : [null, null]
  if (!m || !style) return null
  return { at: m.index, length: m[0].length, name: m[2].toLowerCase(), close: m[1] === '/', style }
}

/** How many characters at the end of `s` could be the start of one of `tags`, cut off by the end of a piece. */
function tagStart(s: string, tags: readonly string[]): number {
  for (let n = Math.min(s.length, 11); n > 0; n--) {
    const tail = s.slice(-n)
    if (tags.some(t => t.length > n && t.startsWith(t.startsWith('<') ? tail.toLowerCase() : tail))) return n
  }
  return 0
}

/**
 * stripThinking for text that is still arriving, a piece at a time: what of
 * each piece can be shown now. A block that opens is held back until it
 * closes, however its tags are cut across pieces, and one that never closes
 * holds back everything after it. A close with no open means everything
 * before it was the thinking (the chat template opened the block in the
 * prompt), so what was shown is taken back (`reset`) — once of each kind, as
 * stripThinking takes out one. A piece that ends in what may be the start of a
 * tag keeps that much back until the next piece says.
 *
 * What it shows is only ever a preview. The answer that counts is
 * stripThinking over the whole text, and the two agree for every shape a model
 * writes; tags mismatched inside a block, which none does, can read differently.
 */
export function thinkingFilter(): { push(text: string): { text: string; reset: boolean }; end(): string } {
  let pending = ''
  let inside: { name: string; style: Style } | null = null
  const loneSeen: Record<Style, boolean> = { angle: false, triangle: false }
  // what has been handed out since the last reset
  let shown = 0
  return {
    push(text) {
      let buf = pending + text
      pending = ''
      let out = ''
      let reset = false
      for (;;) {
        if (inside) {
          const close = inside.style === 'angle' ? `</${inside.name}>` : `◁/${inside.name}▷`
          const at = (inside.style === 'angle' ? buf.toLowerCase() : buf).indexOf(close)
          if (at < 0) {
            const keep = tagStart(buf, [close])
            pending = keep ? buf.slice(-keep) : ''
            break
          }
          buf = buf.slice(at + close.length)
          inside = null
          continue
        }
        const tag = firstTag(buf)
        if (!tag) {
          const keep = tagStart(buf, TAG_TEXTS)
          out += buf.slice(0, buf.length - keep)
          pending = buf.slice(buf.length - keep)
          break
        }
        if (!tag.close) {
          out += buf.slice(0, tag.at)
          inside = { name: tag.name, style: tag.style }
        } else if (loneSeen[tag.style]) {
          // a second close with no open stays in the text, as it does in stripThinking's
          out += buf.slice(0, tag.at + tag.length)
        } else {
          loneSeen[tag.style] = true
          if (shown > 0) reset = true
          shown = 0
          out = ''
        }
        buf = buf.slice(tag.at + tag.length)
      }
      shown += out.length
      return { text: out, reset }
    },
    end() {
      // a tag that never finished was text after all; a block that never closed keeps the rest
      const rest = inside ? '' : pending
      pending = ''
      shown += rest.length
      return rest
    },
  }
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

/**
 * Where the first JSON value in `text` starts, where it ends when it is
 * complete (else -1), and where it could be cut short and still hold only
 * whole items: `lastItem`, the end of the last complete element of a
 * top-level array, and `wrapped`, the same for an array one level inside a
 * top-level object ({"tags": [...]}) — with the brackets that close it.
 * String contents never count as brackets.
 */
export function scanJSON(text: string): { start: number; end: number; lastItem: number; wrapped: string | null } {
  const start = text.search(/[[{]/)
  let end = -1
  let lastItem = -1
  let wrapped: string | null = null
  if (start === -1) return { start, end, lastItem, wrapped }
  const closers: string[] = []
  let inString = false
  let escaped = false
  /** An element of the array being read ends at `i`: remember it if that array is the top level or one level inside it. */
  const itemEnds = (i: number) => {
    if (closers.length === 1 && closers[0] === ']') lastItem = i
    else if (closers.length === 2 && closers[0] === '}' && closers[1] === ']') wrapped = `${text.slice(start, i + 1)}]}`
  }
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        itemEnds(i)
      }
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') closers.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      closers.pop()
      if (closers.length === 0) {
        end = i
        break
      }
      itemEnds(i)
    }
  }
  return { start, end, lastItem, wrapped }
}

/** JSON as a model writes it: read as it is, or with the trailing comma taken out that models leave before a closing bracket. */
export function parseLooseJSON<T>(json: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    try {
      // the commonest slip: a trailing comma before a closing bracket
      return JSON.parse(json.replace(/,\s*([}\]])/g, '$1')) as T
    } catch {
      throw new Error('The model returned malformed JSON — try again.')
    }
  }
}

/**
 * The JSON in a model's reply. Models wrap it in ```json fences, add a
 * sentence before or after it, leave a trailing comma, or stop mid-array when
 * they run out of budget: take the first complete value, and failing that,
 * keep the complete elements of a cut-off array.
 */
export function extractJSON<T>(text: string): T {
  const clean = text.replace(/```(?:json)?/gi, '')
  const { start, end, lastItem } = scanJSON(clean)
  if (start === -1) throw new Error('The model returned no JSON — try again.')
  if (end >= 0) return parseLooseJSON<T>(clean.slice(start, end + 1))
  if (clean[start] === '[' && lastItem > start) return parseLooseJSON<T>(`${clean.slice(start, lastItem + 1)}]`)
  throw new Error('The model’s answer was cut off — try again.')
}

/**
 * Record text made safe to sit inside a prompt's fence (<week>…</week>,
 * <email>…</email>): angle brackets turn into ‹ › so nothing in it can close
 * the fence or open another, blank space collapses — to one line, or with
 * `lines` to single line breaks and at most one blank line — and it is cut to
 * `max`. The brief says what the fence holds is data, not instructions.
 */
export function asData(text: unknown, opts: { lines?: boolean; max?: number } = {}): string {
  const s = String(text ?? '')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
  const flat = opts.lines
    ? s
        .replace(/\r\n?/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ')
  return (opts.max ? flat.trim().slice(0, opts.max) : flat).trim()
}
