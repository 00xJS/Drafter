// Drafter's hosted AI proxy: same contract as the local server's /api/ai.
// Requires a valid Supabase session when Supabase env vars are configured,
// so the public site can't be used to burn Anthropic credits.

import Anthropic from '@anthropic-ai/sdk'

const AI_MODEL = 'claude-opus-5'

export default async req => {
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

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is not set on this site' }, { status: 501 })
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

  const anthropic = new Anthropic()
  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  if (response.stop_reason === 'refusal') return Response.json({ text: '' })
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return Response.json({ text })
}
