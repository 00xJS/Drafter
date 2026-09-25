// Shared AI completion used by /api/ai and (later) digest / inbound / MCP.
// NVIDIA only: the owner's choice (2026-09-23) is NVIDIA keys and no paid
// fallback. The Anthropic path stays, but answers only when the host names it
// with AI_PROVIDER=anthropic; an ANTHROPIC_API_KEY left on the host is unused.
// NVIDIA takes as many keys as the owner adds — NVIDIA_API_KEY, then
// NVIDIA_API_KEY_2, NVIDIA_API_KEY_3 and on — to spread the load and ride out
// rate limits (the free tier is about 40 requests a minute per key). Work the
// server starts by itself (`background`) starts on the second, so the owner's
// own requests keep the main key's quota; a 429 or a 5xx from a key is tried
// on the next, on the same model, and so is a key NVIDIA rejects, while there
// is time. With one key, all of it is exactly as it was.
// JSON mode: lower temperature + response_format on NVIDIA; on Anthropic an
// instruction instead (current Claude models accept no temperature at all).
//
// Every attempt runs against one deadline. A provider that never answers used
// to hold /api/ai open until Netlify killed the function, and the app got the
// platform's error page instead of a reason; now the attempt is aborted when
// the budget runs out and answers a 504 with words the app shows as they are.
//
// What the app shows is said plainly; what the owner needs to fix it — the
// provider's own message, the models tried — goes to the function's log.

import Anthropic from '@anthropic-ai/sdk'
import { stripThinking, thinkingFilter } from '../../../shared/ai.mts'
import { sseEvent, sseReader } from '../../../shared/sse.mts'

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const NVIDIA_FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'openai/gpt-oss-20b',
  // NVIDIA's API names it as its docs page does (nvidia-nemotron-3-nano-30b-a3b)
  'nvidia/nemotron-3-nano-30b-a3b',
]
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5'

/**
 * The models that can be asked to answer without reasoning first, and how:
 * Nemotron 3, Super and Nano, think before every answer unless the request
 * says `chat_template_kwargs: { enable_thinking: false }` — the switch their
 * model cards and NVIDIA's API reference give
 * (docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b).
 * Super is the default model here, and its thinking is why a tag suggestion
 * took twenty seconds and a recipe draft up to a minute. A model not listed
 * is sent nothing, and answers as it always has. The Nano is listed by the
 * name on NVIDIA's model page and by the one NVIDIA_FALLBACK_MODELS gives it.
 */
const THINKING_SWITCH = new Set(['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-nano-30b-a3b', 'nvidia/nemotron-nano-3-30b-a3b'])

/** Models that refused the switch all the same (a 400 naming it): asked without it from then on, on this instance. */
const refusedSwitch = new Set()

/** Models that refused to stream (a 400 naming it): asked for the whole answer from then on, on this instance. */
const refusedStream = new Set()
/** A 400 or 422 about streaming itself. */
const NAMES_STREAM = /\bstream(?:ing)?\b/i

/** What to add to a request to `model` for `reasoning` ('off' or 'on'), or nothing: the caller said neither, or the model has no switch. */
function thinkingSwitch(model, reasoning) {
  if ((reasoning !== 'off' && reasoning !== 'on') || !THINKING_SWITCH.has(model) || refusedSwitch.has(model)) return undefined
  return { chat_template_kwargs: { enable_thinking: reasoning === 'on' } }
}

/** A 400 or 422 about the reasoning switch itself. */
const NAMES_SWITCH = /chat_template_kwargs|enable_thinking/i

/**
 * A 400 about the model rather than the request: this account cannot use it,
 * or it takes no such parameter (JSON mode, say). Another model may do. A 400
 * about the request itself — too long, malformed — used to be sent to every
 * model in turn and come back as "no model was available", which sent the
 * owner looking for a key problem that was not there.
 */
function modelTrouble(message) {
  const text = String(message ?? '')
  return (
    /\b(?:not found|not supported|unsupported|unknown|does not exist|doesn['’]t exist|not available|unavailable|not permitted|unrecognized)\b/i.test(text) &&
    /\b(?:model|function|parameters?|arguments?|fields?|inputs?|response_format)\b/i.test(text)
  )
}

/**
 * How long one completion may take in all — every model and key it tries —
 * counted from when the request began. Netlify stops a synchronous function
 * at 60 s, a limit no setting or plan changes; the last five seconds are for
 * the answer and whatever the handler did first. NVIDIA, tried first,
 * may use all of it: the reasoning model takes 20 to 60 seconds on a recipe
 * draft (measured on the live site), and a further key gets only what is left.
 */
export const AI_BUDGET_MS = 55_000
/** No further attempt (the next NVIDIA key) starts with less than this left. */
export const MIN_ATTEMPT_MS = 5_000

/** The answer for a provider that did not answer inside the budget: a failure like any other, so the app says so. */
const outOfTime = provider => ({ status: 504, error: `${provider} did not answer in time — try again in a moment.` })

/** Time left before `deadline`, enough for one more attempt. */
const roomFor = deadline => deadline - Date.now() >= MIN_ATTEMPT_MS

/**
 * Run one attempt against `deadline` (epoch ms, or Infinity for none): `run`
 * gets a signal that aborts when the deadline passes, and an attempt that
 * ignores the signal is not waited for past it either. Answers `run`'s value,
 * or `late` once time is up. Any other failure is thrown, as before.
 * @template T, L
 * @param {number} deadline
 * @param {(signal?: AbortSignal) => Promise<T>} run
 * @param {L} late
 * @returns {Promise<T | L>}
 */
async function beforeDeadline(deadline, run, late) {
  if (deadline === Infinity) return run(undefined)
  const left = deadline - Date.now()
  if (!(left > 0)) return late
  const ctrl = new AbortController()
  let timer
  const timeUp = new Promise(resolve => {
    // a timer past 2^31 - 1 ms would fire at once
    timer = setTimeout(
      () => {
        ctrl.abort(new Error('the AI budget ran out'))
        resolve(late)
      },
      Math.min(left, 2 ** 31 - 1),
    )
  })
  const work = run(ctrl.signal)
  // once the deadline has answered, a late failure has nobody to tell
  work.catch(() => {})
  try {
    return await Promise.race([work, timeUp])
  } catch (err) {
    if (ctrl.signal.aborted) return late
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * When a completion must be done by: the caller's own `deadline`, or
 * AI_BUDGET_MS from `startedAt` (when the request began; now, if not given).
 * Background work (Sunday's draft, email-in's triage) already stops waiting at
 * a deadline of its own, and the digest runs as a scheduled function with 30
 * s, so it is held to none here unless it passes one.
 */
function deadlineOf({ deadline, startedAt, background = false }) {
  if (Number.isFinite(deadline)) return deadline
  if (background && !Number.isFinite(startedAt)) return Infinity
  return (Number.isFinite(startedAt) ? startedAt : Date.now()) + AI_BUDGET_MS
}

/**
 * The model each NVIDIA key last answered with, by key name: a key whose
 * account cannot serve a model walks on to the next, and that never moves
 * another key off the one it serves.
 */
const resolvedNvidiaModels = new Map()

/** An NVIDIA key's name on the host: NVIDIA_API_KEY, or NVIDIA_API_KEY_ and a number. Nothing else is read as a key. */
export const NVIDIA_KEY_NAME = /^NVIDIA_API_KEY(?:_([1-9]\d{0,2}))?$/

/**
 * The NVIDIA key names the host sets: the main key first, then by number.
 * @returns {import('./ai.mjs').NvidiaKeyName[]}
 */
function nvidiaKeyNames() {
  /** @param {string} name */
  const rank = name => Number(NVIDIA_KEY_NAME.exec(name)?.[1] ?? 1)
  return /** @type {import('./ai.mjs').NvidiaKeyName[]} */ (
    Object.keys(process.env)
      .filter(name => NVIDIA_KEY_NAME.test(name) && process.env[name])
      .sort((a, b) => rank(a) - rank(b) || a.length - b.length)
  )
}

/**
 * The NVIDIA keys a request may use, by name, in the order it tries them: the
 * main key first, or for work the server starts by itself (`background`) the
 * second, with the main key last. Only keys that are set, and one value set
 * under two names is one key. Names, not values: a key goes nowhere but into
 * the request's own header.
 * @param {{ background?: boolean }} [opts]
 */
export function nvidiaKeyOrder({ background = false } = {}) {
  const names = nvidiaKeyNames()
  const seen = new Set()
  return (background ? [...names.slice(1), ...names.slice(0, 1)] : names).filter(name => {
    const key = process.env[name]
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * NVIDIA whenever a key is set, and nothing else unless the host names it:
 * Anthropic answers only with AI_PROVIDER=anthropic as well as its key.
 */
export function resolveProvider() {
  const forced = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (forced === 'anthropic') return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null
  return nvidiaKeyOrder().length ? 'nvidia' : null
}

// A reasoning model's tagged thinking comes out of every answer here, by the
// rule the app's chat reads its replies with (stripThinking, shared/ai.mts).
// Untagged thinking is caught where the answer is read (`looksLikeThinking`).

async function callNvidia(model, messages, maxTokens, { json, temperature, apiKey, signal, extra }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    top_p: 0.95,
    stream: false,
    ...extra,
  }
  if (json) body.response_format = { type: 'json_object' }
  const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (res.ok) return { ok: true, data: await res.json() }
  return { ok: false, status: res.status, message: await failureOf(res) }
}

/** NVIDIA's own words for a request it refused, for the log and for telling a model's trouble from the request's. */
async function failureOf(res) {
  const detail = await res.text().catch(() => '')
  let message = detail.slice(0, 300)
  try {
    const parsed = JSON.parse(detail)
    message = parsed?.error?.message ?? parsed?.detail ?? parsed?.message ?? message
  } catch {
    /* not JSON */
  }
  return message
}

/** The text of a completion's content, a string or a list of parts; never its reasoning, which some builds send in a field of its own. */
function contentText(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('') : ''
}

// ---- streamed answers --------------------------------------------------------
//
// The chat waited twenty seconds for its first word: the model thought first,
// and the whole answer came back at once. Asked to stream, NVIDIA sends the
// answer as it writes it, as server-sent events, and /api/ai sends it on to
// the app the same way (completeStream, below). Only the answer goes on: a
// delta's `reasoning_content`, and any thinking tagged inside its `content`,
// stay here (thinkingFilter mirrors stripThinking, a piece at a time).

/** What went wrong inside a stream NVIDIA had already started: an error event of its own, or an answer that stopped without saying it was done. */
class StreamTrouble extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Said when an answer's own clock runs out part way through it. */
const OUT_OF_BUDGET = 'the AI budget ran out'

/**
 * NVIDIA's event stream, read as the answer's visible words. `next` answers
 * what the next piece of the network's text adds — words to show, and whether
 * what was shown so far must be taken back first — or null once the answer is
 * over. `raw` is every word of `content` NVIDIA wrote, thinking and all: the
 * answer that counts is stripThinking over it, as callNvidia's would be.
 * @param {ReadableStream<Uint8Array>} body
 */
function nvidiaWords(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events = sseReader()
  const thinking = thinkingFilter()
  let raw = ''
  let over = false
  let finished = false
  let said = false
  let heard = false
  /** @param {import('../../../shared/sse.mts').SseEvent[]} list @param {{ text: string, reset: boolean }} piece */
  const take = (list, piece) => {
    for (const { data } of list) {
      if (over) return
      heard = true
      if (data.trim() === '[DONE]') {
        over = true
        said = true
        return
      }
      let chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (chunk?.error) {
        const status = [chunk.error?.status, chunk.error?.code, chunk.status].map(Number).find(n => n >= 400 && n < 600) ?? 502
        throw new StreamTrouble(status, String(chunk.error?.message ?? chunk.error))
      }
      const choice = chunk?.choices?.[0]
      if (choice?.finish_reason) said = true
      const text = contentText(choice?.delta?.content)
      if (!text) continue
      raw += text
      const seen = thinking.push(text)
      if (seen.reset) {
        piece.reset = true
        piece.text = ''
      }
      piece.text += seen.text
    }
  }
  return {
    /** @returns {Promise<{ text: string, reset: boolean } | null>} */
    async next() {
      if (finished) return null
      const piece = { text: '', reset: false }
      if (!over) {
        const { done, value } = await reader.read()
        if (done) {
          take([...events.push(decoder.decode()), ...events.end()], piece)
          // a body with no event in it was never a stream (it is asked for whole)
          if (!heard) throw new Error('the answer came back with no events in it')
          // Taken as the end all the same: a gateway that never says so would
          // otherwise fail every answer, and a connection that drops part way
          // fails the read instead of ending it.
          if (!said) console.error('ai: NVIDIA’s stream closed without [DONE] or a finish reason')
          over = true
        } else take(events.push(decoder.decode(value, { stream: true })), piece)
      }
      if (over) {
        piece.text += thinking.end()
        finished = true
        reader.cancel().catch(() => {})
      }
      return piece
    },
    raw: () => raw,
    close() {
      finished = true
      reader.cancel().catch(() => {})
    },
  }
}

/**
 * One NVIDIA request asked to stream, read as far as the answer's first words
 * (callNvidia is the same request, answered whole). Up to then it fails as
 * callNvidia does — NVIDIA's status and its words, or the status of an error
 * NVIDIA put in the stream — so another model or key can still take over;
 * after them there is nobody to hand over to, since the app already has words
 * on screen. A gateway that answers the whole completion at once is read as
 * callNvidia reads it.
 *
 * `signal` is the attempt's (beforeDeadline's), and stops the wait for the
 * first words; from them on the answer runs on a clock of its own to the same
 * `deadline`, because the attempt's clock stops when it answers.
 */
async function callNvidiaStream(model, messages, maxTokens, { temperature, apiKey, signal, extra, deadline }) {
  const ctrl = new AbortController()
  const follow = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', follow, { once: true })
  let words
  let first = ''
  try {
    const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, top_p: 0.95, stream: true, ...extra }),
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, status: res.status, message: await failureOf(res) }
    // asked to stream, a body is read as one unless it says it is JSON: the whole completion, from a gateway that would not
    if (/json/i.test(res.headers.get('content-type') ?? '') || !res.body) return { ok: true, data: await res.json() }
    words = nvidiaWords(res.body)
    // the first words: blank space alone is not yet an answer to hand on
    while (!first.trim()) {
      const piece = await words.next()
      if (!piece) break
      if (piece.reset) first = ''
      first += piece.text
    }
  } catch (err) {
    words?.close()
    if (err instanceof StreamTrouble) return { ok: false, status: err.status, message: err.message }
    throw err
  } finally {
    // the attempt is answered: its clock stops here, and the answer's own starts
    signal?.removeEventListener('abort', follow)
  }
  const timer = setTimeout(() => ctrl.abort(new Error(OUT_OF_BUDGET)), Math.min(Math.max(deadline - Date.now(), 0), 2 ** 31 - 1))
  return {
    ok: true,
    stream: {
      first,
      words,
      /** Whether the answer's own clock ran out. */
      late: () => ctrl.signal.aborted,
      close() {
        clearTimeout(timer)
        words.close()
        ctrl.abort(new Error('the answer is over'))
      },
    },
  }
}

/**
 * The answer as /api/ai streams it to the app (shared/sse.mts): `delta` events
 * with its words as they come, `reset` when what was shown turned out to be the
 * thinking, and `done` with the whole answer — stripThinking over everything
 * NVIDIA wrote, the text the app would have had without streaming — and the
 * provider and model that wrote it. A failure part way through is an `error`
 * event in the words the app shows, and the app keeps nothing of that answer.
 */
function answerStream(open, model) {
  const encoder = new TextEncoder()
  let over = false
  const finish = () => {
    if (over) return
    over = true
    open.close()
  }
  return new ReadableStream({
    start(controller) {
      if (open.first) controller.enqueue(encoder.encode(sseEvent('delta', { text: open.first })))
    },
    async pull(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)))
      try {
        // a piece with nothing to show (thinking, a role, a keep-alive) is read past: a pull that sends nothing is not asked again
        for (;;) {
          const piece = await open.words.next()
          // the app went away meanwhile
          if (over) return
          if (!piece) {
            send('done', { text: stripThinking(open.words.raw()), provider: 'nvidia', model })
            break
          }
          if (piece.reset) send('reset', {})
          if (piece.text) send('delta', { text: piece.text })
          if (piece.reset || piece.text) return
        }
      } catch (err) {
        if (over) return
        send('error', brokenOff(err, open.late()))
      }
      finish()
      controller.close()
    },
    cancel() {
      finish()
    },
  })
}

/** What the app is told when an answer breaks off part way, in words it shows as they are; the rest goes to the log. */
function brokenOff(err, late) {
  if (late) return { status: 504, error: 'NVIDIA did not answer in time — try again in a moment.' }
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof StreamTrouble) {
    console.error(`ai: NVIDIA's answer broke off (${err.status}): ${message}`)
    return { status: 502, error: 'NVIDIA’s service stopped part way through the answer — try again in a moment.' }
  }
  console.error(`ai: the answer's stream broke: ${message}`)
  return { status: 502, error: 'The assistant’s provider stopped part way through — try again in a moment.' }
}

/**
 * One NVIDIA completion on one key (`keyName`: the first in nvidiaKeyOrder
 * unless given), trying the models in turn while the model is the trouble — a
 * 404, or a 400 that names the model or a parameter it lacks — or only
 * `model` when one is given. Answers the completion and the model NVIDIA
 * answered for (null when none would), so a retry on the next key can ask the
 * same one. A failure carries the status NVIDIA answered (`upstream`), so
 * complete() can tell a rate limit, an outage or a rejected key, which the
 * next key may get past, from anything else. Every model tried shares
 * `deadline` (AI_BUDGET_MS from now when none is given): past it the call is
 * abandoned as a 504. `reasoning: 'off'` asks a model that has a switch for it
 * (THINKING_SWITCH) to answer without thinking first. `stream: true` asks for
 * the answer as it is written, and answers with it on its way once its first
 * words have come (callNvidiaStream); until then everything here holds.
 * @param {import('./ai.mjs').CompletionInput & { keyName?: import('./ai.mjs').NvidiaKeyName, model?: string | null, stream?: boolean }} input
 * @returns {Promise<{ model: string | null, result: import('./ai.mjs').Attempted }>}
 */
async function nvidiaOnKey({ system, prompt, maxTokens, json = false, reasoning, keyName = nvidiaKeyOrder()[0] ?? 'NVIDIA_API_KEY', model: only = null, deadline = Date.now() + AI_BUDGET_MS, stream = false, onModel }) {
  // an NVIDIA key's name, never another variable
  const apiKey = NVIDIA_KEY_NAME.test(keyName) ? process.env[keyName] : undefined
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  const temperature = json ? 0.2 : 0.6
  // The default model reasons before it answers, and its thinking counts
  // against max_tokens: a small JSON budget ended mid-array. Plain text was
  // left on its own budget, on the reasoning that prose has no shape to break —
  // but it breaks worse. The week's review asked for 900 tokens and spent all
  // of them thinking about how to write a review, so what was saved and shown
  // as the review was the thinking, cut off mid-sentence. Every call gets the
  // room now, reasoning off or not (a model with no switch thinks anyway); it
  // is a ceiling, and the prompt still asks for the length.
  const budget = Math.max(maxTokens ?? 0, 2048)

  const configured = process.env.NVIDIA_MODEL?.trim()
  const candidates = only ? [only] : [...new Set([resolvedNvidiaModels.get(keyName), configured, ...NVIDIA_FALLBACK_MODELS].filter(Boolean))]

  /**
   * One request to `model`, and — when the model refuses the reasoning switch
   * its card documents — the same request without it; streamed when asked,
   * unless the model refused a stream, when it is asked for the whole answer.
   */
  const ask = async model => {
    const streams = stream && !refusedStream.has(model)
    const whole = extra => beforeDeadline(deadline, signal => callNvidia(model, messages, budget, { json, temperature, apiKey, signal, extra }), null)
    const send = async extra => {
      if (!streams) return whole(extra)
      try {
        return await beforeDeadline(deadline, signal => callNvidiaStream(model, messages, budget, { temperature, apiKey, signal, extra, deadline }), null)
      } catch (err) {
        // a stream that broke before its first words in a way no status
        // explains — a body that was no stream, a connection dropped — is asked
        // for whole, as every answer was before streaming
        console.error(`ai: ${model} could not be streamed, so it is asked for the whole answer: ${err instanceof Error ? err.message : String(err)}`)
        return whole(extra)
      }
    }
    let extra = thinkingSwitch(model, reasoning)
    let attempt = await send(extra)
    if (extra && attempt && !attempt.ok && (attempt.status === 400 || attempt.status === 422) && NAMES_SWITCH.test(attempt.message)) {
      refusedSwitch.add(model)
      console.error(`ai: ${model} refused the reasoning switch, so it is asked without one: ${attempt.message}`)
      extra = undefined
      attempt = await send(extra)
    }
    if (!streams || !attempt || attempt.ok || (attempt.status !== 400 && attempt.status !== 422) || !NAMES_STREAM.test(attempt.message)) return attempt
    refusedStream.add(model)
    console.error(`ai: ${model} refused to stream, so it is asked for the whole answer: ${attempt.message}`)
    return whole(extra)
  }

  const tried = []
  for (const model of candidates) {
    const attempt = await ask(model)
    if (!attempt) return { model, result: outOfTime('NVIDIA') }
    if (attempt.ok) {
      resolvedNvidiaModels.set(keyName, model)
      // an answer on its way: the words go on as they come (answerStream)
      if (attempt.stream) return { model, result: { stream: attempt.stream, provider: 'nvidia', model } }
      // `content` only, never `message.reasoning_content`: a build that puts
      // the thinking in its own field has already kept it out of the answer,
      // and one that does not is caught by stripThinking or by the reader.
      const text = contentText(attempt.data?.choices?.[0]?.message?.content)
      // who answered, for a caller that keeps it with what it wrote (the nightly recipe drafts)
      onModel?.(model)
      return { model, result: { text: stripThinking(text), provider: 'nvidia' } }
    }
    if (attempt.status === 404 || ((attempt.status === 400 || attempt.status === 422) && modelTrouble(attempt.message))) {
      tried.push(`${model} (${attempt.status})`)
      if (resolvedNvidiaModels.get(keyName) === model) resolvedNvidiaModels.delete(keyName)
      continue
    }
    if (attempt.status === 429)
      return { model, result: { status: 429, upstream: 429, error: 'NVIDIA rate limit hit (the free tier is about 40 requests a minute) — wait a moment and retry.' } }
    if (attempt.status === 401 || attempt.status === 403)
      return { model, result: { status: 502, upstream: attempt.status, error: `NVIDIA rejected the API key — check ${keyName} on the host.` } }
    console.error(`ai: NVIDIA answered ${model} on ${keyName} with HTTP ${attempt.status}${attempt.message ? `: ${attempt.message}` : ''}`)
    if (attempt.status === 400 || attempt.status === 422)
      return { model, result: { status: 502, upstream: attempt.status, error: `NVIDIA couldn’t take that request (HTTP ${attempt.status}) — try again, or with less text.` } }
    return { model, result: { status: 502, upstream: attempt.status, error: `NVIDIA’s service had a problem (HTTP ${attempt.status}) — try again in a moment.` } }
  }
  console.error(`ai: no NVIDIA model answered on ${keyName}. Tried: ${tried.join(', ')}. The models this account can use are listed at ${NVIDIA_BASE_URL}/models.`)
  return {
    model: null,
    result: { status: 502, error: 'None of NVIDIA’s models would answer for this key — the site owner can set NVIDIA_MODEL on the host to one the account can use.' },
  }
}

/**
 * One NVIDIA completion on one key: nvidiaOnKey's answer alone. Admin → Test
 * AI asks each key through it, by name.
 * @param {import('./ai.mjs').CompletionInput & { keyName?: import('./ai.mjs').NvidiaKeyName }} input
 */
export async function completeNvidia(input) {
  // asked without `stream`, never an answer on its way
  return /** @type {import('./ai.mjs').Completion} */ ((await nvidiaOnKey(input)).result)
}

// Models that take output_config.effort (older ones answer it with a 400).
const ANTHROPIC_EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/
// Models with server-side refusal fallbacks in the `fallbacks: "default"` form.
const ANTHROPIC_REFUSAL_FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1'])

/**
 * The request body for one Anthropic completion. Current Claude models (Opus 5,
 * the Opus 4.7+ family, Sonnet 5, Fable) reject temperature / top_p / top_k with
 * a 400, so none is sent — the JSON path used to send temperature 0.2, which made
 * every JSON call on this backup fail. Opus 5 thinks by default and its thinking
 * counts against max_tokens, so these short utility calls run at low effort with
 * headroom, which also keeps them inside the function timeout. A classifier
 * decline re-runs server-side on Anthropic's recommended fallback model.
 */
export function anthropicRequest({ system, prompt, maxTokens, json = false, model }) {
  /** @type {import('./ai.mjs').AnthropicRequest} */
  const request = {
    model,
    max_tokens: Math.max(maxTokens ?? 0, 8000),
    messages: [{ role: 'user', content: prompt }],
  }
  const sys = json ? `${system ?? ''}\n\nRespond with valid JSON only.`.trim() : system
  if (sys) request.system = sys
  if (ANTHROPIC_EFFORT_MODELS.test(model)) request.output_config = { effort: 'low' }
  if (ANTHROPIC_REFUSAL_FALLBACK_MODELS.has(model)) {
    request.betas = ['server-side-fallback-2026-07-01']
    request.fallbacks = 'default'
  }
  return request
}

/**
 * One Anthropic completion, abandoned as a 504 at `deadline` (AI_BUDGET_MS from
 * now when none is given). The SDK's own retries run inside it too.
 * @param {import('./ai.mjs').CompletionInput} input
 * @returns {Promise<import('./ai.mjs').Completion>}
 */
export async function completeAnthropic({ system, prompt, maxTokens, json = false, deadline = Date.now() + AI_BUDGET_MS, onModel }) {
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID
  const anthropic = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {})
  const request = anthropicRequest({
    system,
    prompt,
    maxTokens,
    json,
    model: process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
  })
  const response = await beforeDeadline(
    deadline,
    async signal => (request.betas ? await anthropic.beta.messages.create(request, { signal }) : await anthropic.messages.create(request, { signal })),
    null,
  )
  if (!response) return outOfTime('Anthropic')
  // the whole chain declined (the fallback model can refuse too)
  if (response.stop_reason === 'refusal') return { text: '', provider: 'anthropic' }
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  onModel?.(response.model || request.model)
  return { text, provider: 'anthropic' }
}

/**
 * A throw — the connection dropped, the SDK gave up — answered as a 502 in
 * plain words, with what was thrown in the log.
 * @returns {import('./ai.mjs').Completion}
 */
const thrown = err => {
  console.error(`ai: the provider call threw: ${err instanceof Error ? err.message : String(err)}`)
  return { status: 502, error: 'The assistant’s provider could not be reached — try again in a moment.' }
}

/** One provider's completion, with anything it throws answered as a 502. */
async function attempt(run, input) {
  try {
    return await run(input)
  } catch (err) {
    return thrown(err)
  }
}

/** What the next NVIDIA key may ride out: this key's rate limit, or NVIDIA failing. */
const rideable = r => r.upstream === 429 || (r.upstream ?? 0) >= 500

/** A key NVIDIA would not take: the next key stands in for it. */
const refused = r => r.upstream === 401 || r.upstream === 403

/**
 * NVIDIA on `keys` in turn. The first key's answer stands unless it is one the
 * next key can get past — a rate limit or an outage (rideable), or a key NVIDIA
 * rejects (refused) — and there is time for the next to answer. The next key
 * asks the model the standing answer asked (a rejected key asked none: the
 * next goes by its own). Its answer, or its own rate limit or outage, becomes
 * the standing one; anything else (NVIDIA rejects that key, its account can't
 * serve the model) is that key's trouble, named in the log, and the standing
 * answer stays, so a busy key still reads as busy.
 *
 * A rejected key is named in the log whichever went first, and the next
 * answers in its place: a key revoked or mistyped on the host used to fail
 * every request of the owner's while a good key sat unused beside it. Admin →
 * Test AI still asks each key on its own.
 * @param {import('./ai.mjs').CompletionInput & { stream?: boolean }} input
 * @param {import('./ai.mjs').NvidiaKeyName[]} keys
 * @param {number} until
 * @returns {Promise<import('./ai.mjs').Attempted>}
 */
async function nvidiaOnKeys(input, keys, until) {
  /** @param {import('./ai.mjs').NvidiaKeyName} keyName @param {string | null} model */
  const ask = (keyName, model) => nvidiaOnKey({ ...input, keyName, model }).catch(err => ({ model: null, result: thrown(err) }))
  // the key whose answer stands
  let standing = keys[0]
  let { model, result } = await ask(standing, null)
  if (keys.length > 1 && refused(result)) console.error(`ai: ${result.error}`)
  for (const next of keys.slice(1)) {
    if (!(rideable(result) || refused(result)) || !roomFor(until)) break
    const retry = await ask(next, refused(result) ? null : model)
    if (!retry.result.error) return retry.result
    if (rideable(retry.result)) {
      ;({ model, result } = retry)
      standing = next
    } else console.error(`ai: ${next} could not take over from ${standing}: ${retry.result.error}`)
  }
  return result
}

/**
 * Complete a prompt on NVIDIA, or on Anthropic where the host says
 * AI_PROVIDER=anthropic; one never falls back to the other. `json: true` asks
 * for JSON-shaped output, and `reasoning: 'off'` asks a model that can be told
 * (THINKING_SWITCH) to answer without thinking first. With more than one NVIDIA
 * key, `background: true` (work the server starts by itself) starts on the
 * second, and a 429 or a 5xx from a key is tried on the next, on the same
 * model — as is a key NVIDIA rejects, on whichever model the next key serves.
 *
 * All of it runs inside one budget: AI_BUDGET_MS from `startedAt` (pass the
 * request's own start), or a `deadline` of the caller's. A provider still
 * silent when it runs out answers a 504; each further key starts only with
 * MIN_ATTEMPT_MS left, and gets only what is left.
 * @param {import('./ai.mjs').CompletionInput} input
 * @returns {Promise<import('./ai.mjs').Completion>}
 */
export async function complete({ system = '', prompt, maxTokens = 2048, json = false, reasoning, background = false, startedAt, deadline, onModel }) {
  const primary = resolveProvider()
  if (!primary) {
    return {
      status: 501,
      error: 'AI is not configured on this site: set NVIDIA_API_KEY in the host environment.',
    }
  }

  const until = deadlineOf({ deadline, startedAt, background })
  const input = { system, prompt, maxTokens, json, reasoning, deadline: until, onModel }
  if (primary === 'anthropic') return attempt(completeAnthropic, input)
  // asked without `stream`, never an answer on its way
  return /** @type {Promise<import('./ai.mjs').Completion>} */ (nvidiaOnKeys(input, nvidiaKeyOrder({ background }), until))
}

/**
 * complete(), streamed: the chat's and Ask's answer word by word (/api/ai with
 * `stream: true`). Plain text on NVIDIA only — where the host names Anthropic
 * the answer comes whole, through complete() — and every rule of complete()
 * holds until the answer's first words: the same budget, the same keys in the
 * same order, a model or key that fails before a word has come handed on as
 * complete() hands it on. Once words are on their way there is no handing
 * over: a failure then ends the stream with an `error` event.
 *
 * Answers a failure as complete() does; a whole answer, as complete() does,
 * where NVIDIA would not stream it; or `body`, the event stream for the app
 * (answerStream), with the model that is writing it.
 * @param {Omit<import('./ai.mjs').CompletionInput, 'json' | 'background'>} input
 * @returns {Promise<import('./ai.mjs').StreamedCompletion>}
 */
export async function completeStream({ system = '', prompt, maxTokens = 2048, reasoning, startedAt, deadline }) {
  if (resolveProvider() !== 'nvidia') return complete({ system, prompt, maxTokens, reasoning, startedAt, deadline })
  const until = deadlineOf({ deadline, startedAt })
  const result = await nvidiaOnKeys({ system, prompt, maxTokens, json: false, reasoning, deadline: until, stream: true }, nvidiaKeyOrder(), until)
  if (!result.stream) return result
  return { body: answerStream(result.stream, result.model), provider: 'nvidia', model: result.model }
}
