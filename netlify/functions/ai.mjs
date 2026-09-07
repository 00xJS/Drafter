// Drafter's hosted AI proxy. The browser posts { system, prompt, maxTokens }
// and gets back { text }; which model answers is decided here, server-side.
//
// Providers (pick with AI_PROVIDER=nvidia|anthropic, or leave unset and the
// first one with a key wins, NVIDIA first):
//   - nvidia:    NVIDIA_API_KEY from build.nvidia.com (free developer tier,
//                ~40 requests/min). OpenAI-compatible chat completions against
//                integrate.api.nvidia.com. Model via NVIDIA_MODEL.
//   - anthropic: ANTHROPIC_API_KEY (+ ANTHROPIC_WORKSPACE_ID for identity-linked
//                keys). Model via ANTHROPIC_MODEL.
//
// Requires a valid Supabase session when Supabase env vars are configured,
// so the public site can't be used to burn credits.

import { withCors } from './lib/cors.mjs'
import Anthropic from '@anthropic-ai/sdk'

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
/**
 * Tried in order. A model can be listed in the public catalogue yet still 404
 * on chat/completions for a given account or tier, so one hard-coded name is
 * fragile: every AI feature would break at once. NVIDIA_MODEL, when set, is
 * tried first; the rest are long-standing, widely-served fallbacks.
 */
const NVIDIA_FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'openai/gpt-oss-20b',
  'nvidia/nemotron-nano-3-30b-a3b',
]
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5'

/** Remembered for the life of the warm instance so we don't re-probe every call. */
let resolvedNvidiaModel = null

function resolveProvider() {
  const forced = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (forced === 'nvidia' || forced === 'anthropic') {
    const key = forced === 'nvidia' ? process.env.NVIDIA_API_KEY : process.env.ANTHROPIC_API_KEY
    return key ? forced : null
  }
  if (process.env.NVIDIA_API_KEY) return 'nvidia'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  return null
}

/** Reasoning models (Nemotron, DeepSeek, gpt-oss…) may inline their thinking; drop it. */
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^<think>[\s\S]*$/, '').trim()
}

async function callNvidia(model, messages, maxTokens) {
  const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.6, top_p: 0.95, stream: false }),
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

async function completeNvidia({ system, prompt, maxTokens }) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  // configured model first, then the fallbacks, skipping duplicates
  const configured = process.env.NVIDIA_MODEL?.trim()
  const candidates = [...new Set([resolvedNvidiaModel, configured, ...NVIDIA_FALLBACK_MODELS].filter(Boolean))]

  const tried = []
  for (const model of candidates) {
    const attempt = await callNvidia(model, messages, maxTokens)
    if (attempt.ok) {
      resolvedNvidiaModel = model
      const choice = attempt.data?.choices?.[0]
      const content = choice?.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter(part => part?.type === 'text').map(part => part.text).join('')
          : ''
      return { text: stripThinking(text) }
    }
    // a model this account cannot serve: try the next one
    if (attempt.status === 404 || attempt.status === 400) {
      tried.push(`${model} (${attempt.status})`)
      if (resolvedNvidiaModel === model) resolvedNvidiaModel = null
      continue
    }
    // anything else is about the request or the key, not the model — stop here
    if (attempt.status === 429) return { status: 429, error: 'NVIDIA rate limit hit (the free tier is about 40 requests a minute) — wait a moment and retry.' }
    if (attempt.status === 401 || attempt.status === 403) return { status: 502, error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.' }
    return { status: 502, error: `NVIDIA API error (HTTP ${attempt.status})${attempt.message ? `: ${attempt.message}` : ''}` }
  }
  return {
    status: 502,
    error: `No NVIDIA model was available for this key. Tried: ${tried.join(', ')}. Set NVIDIA_MODEL on the host to one your account can serve (list them at ${NVIDIA_BASE_URL}/models).`,
  }
}

async function completeAnthropic({ system, prompt, maxTokens }) {
  // identity-linked keys without a workspace scope require this header
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID
  const anthropic = new Anthropic(
    workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {},
  )
  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  if (response.stop_reason === 'refusal') return { text: '' }
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return { text }
}

const handler = async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (supabaseUrl && anonKey) {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return Response.json({ error: 'sign in required' }, { status: 401 })
    const check = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` },
    })
    if (!check.ok) return Response.json({ error: 'invalid session' }, { status: 401 })
  }

  const provider = resolveProvider()
  if (!provider) {
    return Response.json(
      { error: 'AI is not configured on this site: set NVIDIA_API_KEY (or ANTHROPIC_API_KEY) in the host environment.' },
      { status: 501 },
    )
  }

  let body
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const system = typeof body?.system === 'string' ? body.system : ''
  const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
  if (!prompt) return Response.json({ error: 'prompt is required' }, { status: 400 })
  const maxTokens = Math.min(Math.max(Number(body?.maxTokens) || 2048, 256), 8192)

  const complete = provider === 'nvidia' ? completeNvidia : completeAnthropic
  let result
  try {
    result = await complete({ system, prompt, maxTokens })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `AI request failed: ${message}` }, { status: 502 })
  }
  if (result.error) return Response.json({ error: result.error }, { status: result.status ?? 502 })
  return Response.json({ text: result.text, provider })
}

export default withCors(handler)
