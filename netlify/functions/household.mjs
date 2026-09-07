// Household membership (service role): who shares a planner with whom.
//   POST /api/household { action } — session-gated
//     status | create { name } | invite { email } | remove { userId } | leave | rename { name } | me { displayName }
// Accounts are still created by the site owner in Supabase; inviting someone
// just links an existing account to your household.

import { withCors } from './lib/cors.mjs'
import { getUser, settingsGet, settingsSet, settingsStoreConfigured } from './lib/session.mjs'

function env() {
  return { url: process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY }
}

async function rest(path, init = {}) {
  const e = env()
  const res = await fetch(`${e.url}/rest/v1/${path}`, { ...init, headers: { apikey: e.key, authorization: `Bearer ${e.key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`${path.split('?')[0]} ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function adminUsers() {
  const e = env()
  const out = []
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${e.url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: { apikey: e.key, authorization: `Bearer ${e.key}` } })
    if (!res.ok) break
    const body = await res.json()
    const list = body.users ?? []
    out.push(...list)
    if (list.length < 200) break
  }
  return out
}

async function membershipOf(userId) {
  const rows = await rest(`household_members?user_id=eq.${userId}&select=household_id,role&limit=1`)
  return rows?.[0] ?? null
}

async function describe(userId) {
  const m = await membershipOf(userId)
  if (!m) return { household: null, members: [] }
  const [household] = await rest(`households?id=eq.${m.household_id}&select=id,name,created_by`)
  const rows = await rest(`household_members?household_id=eq.${m.household_id}&select=user_id,role,joined_at`)
  const users = await adminUsers()
  const settings = await rest(`user_settings?user_id=in.(${rows.map(r => r.user_id).join(',')})&select=user_id,display_name`).catch(() => [])
  const members = rows.map(r => {
    const u = users.find(x => x.id === r.user_id)
    const s = settings.find(x => x.user_id === r.user_id)
    return { id: r.user_id, email: u?.email ?? '', displayName: s?.display_name ?? (u?.email ? u.email.split('@')[0] : 'member'), role: r.role, joinedAt: r.joined_at }
  })
  return { household, members }
}

const handler = async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const { user, response, unconfigured } = await getUser(req)
  if (response) return response
  if (unconfigured || !user) return Response.json({ error: 'Households need a signed-in account.' }, { status: 501 })
  if (!settingsStoreConfigured()) return Response.json({ error: 'Households need SUPABASE_SERVICE_KEY on the host.' }, { status: 501 })
  const body = await req.json().catch(() => ({}))

  try {
    const mine = await settingsGet(user.id)
    if (body.action === 'status') {
      const invites = await rest(`household_invites?user_id=eq.${encodeURIComponent(user.id)}&select=household_id,created_at`).catch(() => [])
      const withNames = []
      for (const inv of invites ?? []) {
        const [h] = await rest(`households?id=eq.${inv.household_id}&select=id,name`).catch(() => [])
        if (h) withNames.push({ householdId: h.id, name: h.name })
      }
      return Response.json({ me: { id: user.id, email: user.email, displayName: mine?.display_name ?? null }, invites: withNames, ...(await describe(user.id)) })
    }
    if (body.action === 'accept') {
      // consent step: only the invitee can turn their own invitation into membership
      const [inv] = await rest(`household_invites?user_id=eq.${encodeURIComponent(user.id)}&household_id=eq.${encodeURIComponent(String(body.householdId ?? ''))}&select=household_id`).catch(() => [])
      if (!inv) return Response.json({ error: 'That invitation is no longer available.' }, { status: 404 })
      if (await membershipOf(user.id)) return Response.json({ error: 'You are already in a household — leave it first.' }, { status: 409 })
      await rest('household_members', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ household_id: inv.household_id, user_id: user.id, role: 'member' }) })
      await rest(`household_invites?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => {})
      return Response.json(await describe(user.id))
    }
    if (body.action === 'decline') {
      await rest(`household_invites?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => {})
      return Response.json({ ...(await describe(user.id)), invites: [] })
    }
    if (body.action === 'me') {
      await settingsSet(user.id, { display_name: String(body.displayName ?? '').trim().slice(0, 40) || null })
      return Response.json({ ok: true })
    }
    if (body.action === 'create') {
      if (await membershipOf(user.id)) return Response.json({ error: 'You are already in a household — leave it first.' }, { status: 409 })
      const [h] = await rest('households', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ name: String(body.name ?? 'Home').trim().slice(0, 60) || 'Home', created_by: user.id }) })
      await rest('household_members', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ household_id: h.id, user_id: user.id, role: 'owner' }) })
      return Response.json(await describe(user.id))
    }
    const m = await membershipOf(user.id)
    if (!m) return Response.json({ error: 'Create a household first.' }, { status: 409 })
    if (body.action === 'invite') {
      // Joining a household grants full read/write of everyone's records, so it
      // takes the owner's action AND the invitee's consent. Inserting the
      // membership directly would let anyone absorb another account silently.
      if (m.role !== 'owner') return Response.json({ error: 'Only the household owner can invite people.' }, { status: 403 })
      const email = String(body.email ?? '').trim().toLowerCase()
      const target = (await adminUsers()).find(u => (u.email ?? '').toLowerCase() === email)
      // one generic reply for every outcome, so this cannot be used to probe
      // which email addresses have accounts on the deployment
      const sent = Response.json({ ...(await describe(user.id)), invited: email, note: 'If that account exists, the invitation is waiting for them to accept in their own Settings.' })
      if (!target || target.id === user.id) return sent
      if (await membershipOf(target.id)) return sent
      await rest('household_invites', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ household_id: m.household_id, user_id: target.id, invited_by: user.id }),
      })
      return sent
    }
    if (body.action === 'remove') {
      if (m.role !== 'owner') return Response.json({ error: 'Only the household owner can remove members.' }, { status: 403 })
      if (body.userId === user.id) return Response.json({ error: 'Use leave to remove yourself.' }, { status: 400 })
      await rest(`household_members?household_id=eq.${m.household_id}&user_id=eq.${body.userId}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } })
      return Response.json(await describe(user.id))
    }
    if (body.action === 'leave') {
      await rest(`household_members?household_id=eq.${m.household_id}&user_id=eq.${user.id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } })
      const left = await rest(`household_members?household_id=eq.${m.household_id}&select=user_id`)
      if (left.length === 0) await rest(`households?id=eq.${m.household_id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } })
      return Response.json({ household: null, members: [] })
    }
    if (body.action === 'rename') {
      await rest(`households?id=eq.${m.household_id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ name: String(body.name ?? '').trim().slice(0, 60) || 'Home' }) })
      return Response.json(await describe(user.id))
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    return Response.json({ error: e?.message ?? 'household request failed' }, { status: 502 })
  }
}

export default withCors(handler)
