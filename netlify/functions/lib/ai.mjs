// Shared AI completion used by /api/ai and (later) digest / inbound / MCP.
// NVIDIA first when keyed; Anthropic as runtime fallback on 429/502.
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

let resolvedNvidiaModel = null

export function resolveProvider() {
  const forced = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (forced === 'nvidia' || forced === 'anthropic') {
    const key = forced === 'nvidia' ? process.env.NVIDIA_API_KEY : process.env.ANTHROPIC_API_KEY
    return key ? forced : null
  }
  if (process.env.NVIDIA_API_KEY) return 'nvidia'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  return null
}

function stripThinking(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^<think>[\s\S]*$/, '')
    .trim()
}

async function callNvidia(model, messages, maxTokens, { json, temperature }) {
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
      authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
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

export async function completeNvidia({ system, prompt, maxTokens, json = false }) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  const temperature = json ? 0.2 : 0.6
  // the default model reasons before it answers, and its thinking counts
  // against max_tokens: a small JSON budget ended mid-array
  const budget = json ? Math.max(maxTokens ?? 0, 2048) : maxTokens

  const configured = process.env.NVIDIA_MODEL?.trim()
  const candidates = [...new Set([resolvedNvidiaModel, configured, ...NVIDIA_FALLBACK_MODELS].filter(Boolean))]

  const tried = []
  for (const model of candidates) {
    const attempt = await callNvidia(model, messages, budget, { json, temperature })
    if (attempt.ok) {
      resolvedNvidiaModel = model
      const choice = attempt.data?.choices?.[0]
      const content = choice?.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter(part => part?.type === 'text').map(part => part.text).join('')
            : ''
      return { text: stripThinking(text), provider: 'nvidia' }
    }
    if (attempt.status === 404 || attempt.status === 400) {
      tried.push(`${model} (${attempt.status})`)
      if (resolvedNvidiaModel === model) resolvedNvidiaModel = null
      continue
    }
    if (attempt.status === 429)
      return { status: 429, error: 'NVIDIA rate limit hit (the free tier is about 40 requests a minute) — wait a moment and retry.' }
    if (attempt.status === 401 || attempt.status === 403)
      return { status: 502, error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.' }
    return { status: 502, error: `NVIDIA API error (HTTP ${attempt.status})${attempt.message ? `: ${attempt.message}` : ''}` }
  }
  return {
    status: 502,
    error: `No NVIDIA model was available for this key. Tried: ${tried.join(', ')}. Set NVIDIA_MODEL on the host to one your account can serve (list them at ${NVIDIA_BASE_URL}/models).`,
  }
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
 * Complete a prompt. Prefers NVIDIA when available; on 429/502 retries once via
 * Anthropic when that key is set. `json: true` asks for JSON-shaped output.
 */
export async function complete({ system = '', prompt, maxTokens = 2048, json = false }) {
  const primary = resolveProvider()
  if (!primary) {
    return {
      status: 501,
      error: 'AI is not configured on this site: set NVIDIA_API_KEY (or ANTHROPIC_API_KEY) in the host environment.',
    }
  }

  const run = primary === 'nvidia' ? completeNvidia : completeAnthropic
  let result
  try {
    result = await run({ system, prompt, maxTokens, json })
  } catch (err) {
    result = { status: 502, error: err instanceof Error ? err.message : String(err) }
  }

  const retryable = result.status === 429 || result.status === 502
  if (retryable && primary === 'nvidia' && process.env.ANTHROPIC_API_KEY) {
    try {
      const fallback = await completeAnthropic({ system, prompt, maxTokens, json })
      if (!fallback.error) return fallback
    } catch {
      /* keep original error */
    }
  }
  return result
}
