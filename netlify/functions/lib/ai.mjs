// Shared AI completion used by /api/ai and (later) digest / inbound / MCP.
// NVIDIA first when keyed; Anthropic as runtime fallback on 429/502.
// JSON mode: lower temperature + response_format when the caller asks for JSON.

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

  const configured = process.env.NVIDIA_MODEL?.trim()
  const candidates = [...new Set([resolvedNvidiaModel, configured, ...NVIDIA_FALLBACK_MODELS].filter(Boolean))]

  const tried = []
  for (const model of candidates) {
    const attempt = await callNvidia(model, messages, maxTokens, { json, temperature })
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

export async function completeAnthropic({ system, prompt, maxTokens, json = false }) {
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID
  const anthropic = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {})
  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: maxTokens,
    temperature: json ? 0.2 : undefined,
    system: json ? `${system}\n\nRespond with valid JSON only.` : system,
    messages: [{ role: 'user', content: prompt }],
  })
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
