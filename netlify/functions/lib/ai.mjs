// Shared AI completion used by /api/ai and (later) digest / inbound / MCP.
// NVIDIA first when keyed; Anthropic as runtime fallback on 429/502.
// NVIDIA may hold a second key, NVIDIA_API_KEY_2, to spread the load and ride
// out rate limits (the free tier is about 40 requests a minute per key). Work
// the server starts by itself (`background`) tries it first, so the owner's
// own requests keep the main key's quota; a 429 or a 5xx from the key tried
// first is tried once on the other, on the same model, and only then does the
// Anthropic fallback apply. With the second key unset, all of it is exactly as
// it was.
// JSON mode: lower temperature + response_format on NVIDIA; on Anthropic an
// instruction instead (current Claude models accept no temperature at all).

import Anthropic from '@anthropic-ai/sdk'

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const NVIDIA_FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'openai/gpt-oss-20b',
  'nvidia/nemotron-nano-3-30b-a3b',
]
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5'

/**
 * The model each NVIDIA key last answered with, by key name: a key whose
 * account cannot serve a model walks on to the next, and that never moves the
 * other key off the one it serves.
 */
const resolvedNvidiaModels = new Map()

/** The main NVIDIA key and the optional second one, by the names they have on the host. */
const NVIDIA_KEYS = /** @type {const} */ (['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2'])

/**
 * The NVIDIA keys a request may use, by name, in the order it tries them: the
 * main key first, or for work the server starts by itself (`background`) the
 * second. Only keys that are set, and one value set under both names is one
 * key, so a request never has more than one other key to try. Names, not
 * values: a key goes nowhere but into the request's own header.
 * @param {{ background?: boolean }} [opts]
 */
export function nvidiaKeyOrder({ background = false } = {}) {
  const seen = new Set()
  return (background ? [NVIDIA_KEYS[1], NVIDIA_KEYS[0]] : [...NVIDIA_KEYS]).filter(name => {
    const key = process.env[name]
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function resolveProvider() {
  const forced = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (forced === 'nvidia' || forced === 'anthropic') {
    // either NVIDIA key makes NVIDIA configured
    const keyed = forced === 'nvidia' ? nvidiaKeyOrder().length > 0 : !!process.env.ANTHROPIC_API_KEY
    return keyed ? forced : null
  }
  if (nvidiaKeyOrder().length) return 'nvidia'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  return null
}

/**
 * A reasoning model's thinking, out of the text. Tagged thinking is the easy
 * half — a closed block, or an opening tag whose close never arrived because
 * the budget ran out. Models tag it `<think>`, `<thinking>` or `<reasoning>`,
 * and some NIM builds wrap it in `◁think▷` instead of angle brackets.
 *
 * The hard half is untagged thinking, which no rule here can see: NVIDIA's
 * default answered a review with 900 tokens of "We need to produce a personal
 * review…" and never reached the review. That one is caught where the answer
 * is read (`looksLikeThinking` in src/ai.ts), not here.
 */
function stripThinking(text) {
  return String(text ?? '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/g, '')
    .replace(/^\s*<(think|thinking|reasoning)>[\s\S]*$/, '')
    .replace(/◁(think|thinking)▷[\s\S]*?◁\/\1▷/g, '')
    .replace(/^\s*◁(think|thinking)▷[\s\S]*$/, '')
    .trim()
}

async function callNvidia(model, messages, maxTokens, { json, temperature, apiKey }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    top_p: 0.95,
    stream: false,
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
  })
  if (res.ok) return { ok: true, data: await res.json() }
  const detail = await res.text().catch(() => '')
  let message = detail.slice(0, 300)
  try {
    const parsed = JSON.parse(detail)
    message = parsed?.error?.message ?? parsed?.detail ?? parsed?.message ?? message
  } catch {
    /* not JSON */
  }
  return { ok: false, status: res.status, message }
}

/**
 * One NVIDIA completion on one key (`keyName`: the first in nvidiaKeyOrder
 * unless given), trying the models in turn while the model is the trouble, or
 * only `model` when one is given. Answers the completion and the model NVIDIA
 * answered for (null when none would), so a retry on the other key can ask the
 * same one. A failure carries the status NVIDIA answered (`upstream`), so
 * complete() can tell a rate limit or an outage, which the other key may ride
 * out, from anything else.
 * @param {import('./ai.mjs').CompletionInput & { keyName?: 'NVIDIA_API_KEY' | 'NVIDIA_API_KEY_2', model?: string | null }} input
 * @returns {Promise<{ model: string | null, result: import('./ai.mjs').Completion }>}
 */
async function nvidiaOnKey({ system, prompt, maxTokens, json = false, keyName = nvidiaKeyOrder()[0] ?? NVIDIA_KEYS[0], model: only = null }) {
  // one of the two NVIDIA names, never another variable
  const apiKey = NVIDIA_KEYS.includes(keyName) ? process.env[keyName] : undefined
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
  // room now; it is a ceiling, and the prompt still asks for the length.
  const budget = Math.max(maxTokens ?? 0, 2048)

  const configured = process.env.NVIDIA_MODEL?.trim()
  const candidates = only ? [only] : [...new Set([resolvedNvidiaModels.get(keyName), configured, ...NVIDIA_FALLBACK_MODELS].filter(Boolean))]

  const tried = []
  for (const model of candidates) {
    const attempt = await callNvidia(model, messages, budget, { json, temperature, apiKey })
    if (attempt.ok) {
      resolvedNvidiaModels.set(keyName, model)
      const choice = attempt.data?.choices?.[0]
      const content = choice?.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter(part => part?.type === 'text').map(part => part.text).join('')
            : ''
      // `content` only, never `message.reasoning_content`: a build that puts
      // the thinking in its own field has already kept it out of the answer,
      // and one that does not is caught by stripThinking or by the reader.
      return { model, result: { text: stripThinking(text), provider: 'nvidia' } }
    }
    if (attempt.status === 404 || attempt.status === 400) {
      tried.push(`${model} (${attempt.status})`)
      if (resolvedNvidiaModels.get(keyName) === model) resolvedNvidiaModels.delete(keyName)
      continue
    }
    if (attempt.status === 429)
      return { model, result: { status: 429, upstream: 429, error: 'NVIDIA rate limit hit (the free tier is about 40 requests a minute) — wait a moment and retry.' } }
    if (attempt.status === 401 || attempt.status === 403)
      return { model, result: { status: 502, upstream: attempt.status, error: `NVIDIA rejected the API key — check ${keyName} on the host.` } }
    return { model, result: { status: 502, upstream: attempt.status, error: `NVIDIA API error (HTTP ${attempt.status})${attempt.message ? `: ${attempt.message}` : ''}` } }
  }
  return {
    model: null,
    result: {
      status: 502,
      error: `No NVIDIA model was available for this key. Tried: ${tried.join(', ')}. Set NVIDIA_MODEL on the host to one your account can serve (list them at ${NVIDIA_BASE_URL}/models).`,
    },
  }
}

/**
 * One NVIDIA completion on one key: nvidiaOnKey's answer alone. Admin → Test
 * AI asks each key through it, by name.
 * @param {import('./ai.mjs').CompletionInput & { keyName?: 'NVIDIA_API_KEY' | 'NVIDIA_API_KEY_2' }} input
 */
export async function completeNvidia(input) {
  return (await nvidiaOnKey(input)).result
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

export async function completeAnthropic({ system, prompt, maxTokens, json = false }) {
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID
  const anthropic = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {})
  const request = anthropicRequest({
    system,
    prompt,
    maxTokens,
    json,
    model: process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
  })
  const response = request.betas ? await anthropic.beta.messages.create(request) : await anthropic.messages.create(request)
  // the whole chain declined (the fallback model can refuse too)
  if (response.stop_reason === 'refusal') return { text: '', provider: 'anthropic' }
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return { text, provider: 'anthropic' }
}

/**
 * A throw, answered as a 502.
 * @returns {import('./ai.mjs').Completion}
 */
const thrown = err => ({ status: 502, error: err instanceof Error ? err.message : String(err) })

/** One provider's completion, with anything it throws answered as a 502. */
async function attempt(run, input) {
  try {
    return await run(input)
  } catch (err) {
    return thrown(err)
  }
}

/** What the other NVIDIA key may ride out: this key's rate limit, or NVIDIA failing. */
const rideable = r => r.upstream === 429 || (r.upstream ?? 0) >= 500

/**
 * Complete a prompt. Prefers NVIDIA when available; on 429/502 retries once via
 * Anthropic when that key is set. `json: true` asks for JSON-shaped output.
 * With a second NVIDIA key, `background: true` (work the server starts by
 * itself) tries that key first, and a 429 or a 5xx from the key tried first is
 * tried once on the other, on the same model, before the Anthropic fallback.
 */
export async function complete({ system = '', prompt, maxTokens = 2048, json = false, background = false }) {
  const primary = resolveProvider()
  if (!primary) {
    return {
      status: 501,
      error: 'AI is not configured on this site: set NVIDIA_API_KEY (or ANTHROPIC_API_KEY) in the host environment.',
    }
  }

  const input = { system, prompt, maxTokens, json }
  let result
  if (primary === 'nvidia') {
    const [first, other] = nvidiaKeyOrder({ background })
    const tried = await nvidiaOnKey({ ...input, keyName: first }).catch(err => ({ model: null, result: thrown(err) }))
    result = tried.result
    // with two keys, one may go first only for work nobody watches (Sunday's
    // draft, email-in), so a key NVIDIA rejects is named in the log
    if (other && (result.upstream === 401 || result.upstream === 403)) console.error(`ai: ${result.error}`)
    // once, and only for what the other key can ride out, asking the model the first key asked
    if (other && rideable(result)) {
      const retry = (await nvidiaOnKey({ ...input, keyName: other, model: tried.model }).catch(err => ({ model: null, result: thrown(err) }))).result
      // the other key's answer, or its own rate limit or outage. Anything else
      // (NVIDIA rejects that key, its account can't serve the model, no answer
      // at all) is that key's trouble: the first key's answer stands, so a
      // busy key still reads as busy, and the log says which key it was
      if (!retry.error || rideable(retry)) result = retry
      else console.error(`ai: ${other} could not take over from ${first}: ${retry.error}`)
    }
  } else {
    result = await attempt(completeAnthropic, input)
  }

  const retryable = result.status === 429 || result.status === 502
  if (retryable && primary === 'nvidia' && process.env.ANTHROPIC_API_KEY) {
    try {
      const fallback = await completeAnthropic(input)
      if (!fallback.error) return fallback
    } catch {
      /* keep original error */
    }
  }
  return result
}
