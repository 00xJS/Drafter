// Drafter's hosted AI proxy. The browser posts { system, prompt, maxTokens, json,
// reasoning } and gets back { text, provider }. Provider selection and fallback
// live in lib/ai.mjs.
//
// The owner's AI keys sit behind this, so it fails closed: no valid session is
// a 401, and a host missing its auth settings answers 503. It used to skip the
// session check in that case, which would have opened the keys to anyone.

import { withCors } from './lib/cors.mjs'
import { complete, resolveProvider } from './lib/ai.mjs'
import { sharedWindow } from './lib/ratelimit.mjs'
import { requireUser } from './lib/session.mjs'

/** The most one call may ask for, whatever the client sends. */
const MAX_TOKENS = 4096
/**
 * The most text one call may send, brief and prompt together. The app's
 * biggest — a pasted recipe, the recipe suggester's sixty recipes — are well
 * under half of it; anything past it is a runaway, not a question, and is
 * turned away before it costs a request of the account's thirty.
 */
const MAX_TEXT_BYTES = 64 * 1024
// About 30 calls per 10 minutes per account, counted across every instance
// (lib/ratelimit.mjs, public.rate_limit_take), so a runaway loop or a leaked
// session cannot drain the provider's quota by landing on fresh cold starts.
const perUser = sharedWindow({ bucket: 'ai', limit: 30, windowMs: 10 * 60_000 })

const handler = async req => {
  // the AI budget counts from here: checking the session spends some of it
  const startedAt = Date.now()
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
  if (Buffer.byteLength(system, 'utf8') + Buffer.byteLength(prompt, 'utf8') > MAX_TEXT_BYTES) {
    return Response.json({ error: 'That is more text than the assistant takes at once — try again with less.' }, { status: 413 })
  }
  const maxTokens = Math.min(Math.max(Number(body?.maxTokens) || 2048, 256), MAX_TOKENS)
  const json = !!body?.json
  // the utility calls (tags, steps, a capture, a recipe) ask for an answer
  // without the model's thinking first; anything else is not a setting
  const reasoning = body?.reasoning === 'off' || body?.reasoning === 'on' ? body.reasoning : undefined

  // counted only for a call that would actually reach the provider
  const slot = await perUser.take(user.id)
  if (!slot.ok) {
    const seconds = Math.ceil(slot.retryAfterMs / 1000)
    return Response.json(
      { error: `Too many AI requests from this account — try again in ${Math.max(1, Math.ceil(seconds / 60))} min.` },
      { status: 429, headers: { 'retry-after': String(seconds) } },
    )
  }

  let result
  try {
    result = await complete({ system, prompt, maxTokens, json, reasoning, startedAt })
  } catch (err) {
    console.error(`ai: the request failed: ${err instanceof Error ? err.message : String(err)}`)
    return Response.json({ error: 'The assistant couldn’t answer — try again in a moment.' }, { status: 502 })
  }
  if (result.error) return Response.json({ error: result.error }, { status: result.status ?? 502 })
  return Response.json({ text: result.text, provider: result.provider })
}

export default withCors(handler)
