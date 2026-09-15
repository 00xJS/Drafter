// Drafter's hosted AI proxy. The browser posts { system, prompt, maxTokens, json }
// and gets back { text, provider }. Provider selection and fallback live in lib/ai.mjs.
//
// The owner's AI keys sit behind this, so it fails closed: no valid session is
// a 401, and a host missing its auth settings answers 503. It used to skip the
// session check in that case, which would have opened the keys to anyone.

import { withCors } from './lib/cors.mjs'
import { complete, resolveProvider } from './lib/ai.mjs'
import { slidingWindow } from './lib/ratelimit.mjs'
import { requireUser } from './lib/session.mjs'

/** The most one call may ask for, whatever the client sends. */
const MAX_TOKENS = 4096
// About 30 calls per 10 minutes per account. Per warm instance and best effort
// (see lib/ratelimit.mjs): it stops a runaway loop or a leaked session from
// draining the provider's quota, not someone spreading calls over cold starts.
const perUser = slidingWindow({ limit: 30, windowMs: 10 * 60_000 })

const handler = async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const { user, response } = await requireUser(req)
  if (response) return response

  if (!resolveProvider()) {
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
  const maxTokens = Math.min(Math.max(Number(body?.maxTokens) || 2048, 256), MAX_TOKENS)
  const json = !!body?.json

  // counted only for a call that would actually reach the provider
  const slot = perUser.take(user.id)
  if (!slot.ok) {
    const seconds = Math.ceil(slot.retryAfterMs / 1000)
    return Response.json(
      { error: `Too many AI requests from this account — try again in ${Math.max(1, Math.ceil(seconds / 60))} min.` },
      { status: 429, headers: { 'retry-after': String(seconds) } },
    )
  }

  let result
  try {
    result = await complete({ system, prompt, maxTokens, json })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `AI request failed: ${message}` }, { status: 502 })
  }
  if (result.error) return Response.json({ error: result.error }, { status: result.status ?? 502 })
  return Response.json({ text: result.text, provider: result.provider })
}

export default withCors(handler)
