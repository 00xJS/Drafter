// Drafter's hosted AI proxy. The browser posts { system, prompt, maxTokens, json }
// and gets back { text, provider }. Provider selection and fallback live in lib/ai.mjs.

import { withCors } from './lib/cors.mjs'
import { complete, resolveProvider } from './lib/ai.mjs'

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
  const maxTokens = Math.min(Math.max(Number(body?.maxTokens) || 2048, 256), 8192)
  const json = !!body?.json

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
