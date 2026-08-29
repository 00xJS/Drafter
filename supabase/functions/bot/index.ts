// Scoped bot gateway: automations authenticate with BOT_TOKEN (a shared
// secret set via `supabase secrets set`) instead of the service_role key.
// The token can only read posts and write through the LWW-merged sync RPC —
// it cannot touch auth, app_config (ownership), storage, or anything else.

import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async req => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 })
  }
  const expected = Deno.env.get('BOT_TOKEN')
  const token = req.headers.get('x-bot-token')
  if (!expected || !token || token !== expected) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }

  // { action: "sync", posts: [...], since?: iso } — LWW-safe write + read
  if (body.action === 'sync') {
    const { data, error } = await admin.rpc('sync_posts', {
      incoming: Array.isArray(body.posts) ? body.posts : [],
      since: typeof body.since === 'string' ? body.since : null,
    })
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ posts: data })
  }

  // { action: "list", status?, limit? } — filtered read of live posts
  if (body.action === 'list') {
    let q = admin.from('posts').select('data').eq('deleted', false).order('updated_at', { ascending: false })
    if (typeof body.status === 'string') q = q.eq('status', body.status)
    q = q.limit(Math.min(Math.max(Number(body.limit) || 100, 1), 1000))
    const { data, error } = await q
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ posts: (data ?? []).map(r => (r as { data: unknown }).data) })
  }

  return Response.json({ error: 'unknown action (use "sync" or "list")' }, { status: 400 })
})
