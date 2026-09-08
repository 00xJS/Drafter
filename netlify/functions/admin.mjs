// Site-owner Admin API (service role): integration health + Auth user ops.
//   POST /api/admin { action } — session-gated
//     me | status | listUsers | createUser | inviteUser | resetPassword | setDisabled
// Owner = JWT email matches app_config.owner_email. Never returns secrets.

import { withCors } from './lib/cors.mjs'
import { getUser, settingsStoreConfigured } from './lib/session.mjs'
import { googleConfigured, missingGoogleEnv } from './lib/google.mjs'
import { microsoftConfigured, missingMicrosoftEnv } from './lib/microsoft.mjs'
import { apnsConfigured, missingApnsEnv } from './lib/apns.mjs'

const webPushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)

function env() {
  return { url: process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY }
}

async function rest(path, init = {}) {
  const e = env()
  const res = await fetch(`${e.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: e.key, authorization: `Bearer ${e.key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${path.split('?')[0]} ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function authAdmin(path, init = {}) {
  const e = env()
  const res = await fetch(`${e.url}/auth/v1/admin/${path}`, {
    ...init,
    headers: { apikey: e.key, authorization: `Bearer ${e.key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(body?.msg ?? body?.error_description ?? body?.error ?? `auth admin ${res.status}`)
  return body
}

async function ownerEmail() {
  const rows = await rest(`app_config?key=eq.owner_email&select=value&limit=1`)
  return (rows?.[0]?.value ?? '').trim().toLowerCase() || null
}

async function requireOwner(user) {
  if (!settingsStoreConfigured()) return { error: Response.json({ error: 'Admin needs SUPABASE_SERVICE_KEY on the host.' }, { status: 501 }) }
  const owner = await ownerEmail()
  if (!owner) return { error: Response.json({ error: 'Owner email is not set (app_config.owner_email).' }, { status: 501 }) }
  const email = (user.email ?? '').trim().toLowerCase()
  if (!email || email !== owner) return { error: Response.json({ error: 'Forbidden' }, { status: 403 }), isOwner: false }
  return { isOwner: true }
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email ?? '',
    createdAt: u.created_at ?? null,
    lastSignInAt: u.last_sign_in_at ?? null,
    confirmedAt: u.email_confirmed_at ?? null,
    disabled: !!(u.banned_until && Date.parse(u.banned_until) > Date.now()),
    bannedUntil: u.banned_until ?? null,
  }
}

async function listUsers() {
  const out = []
  for (let page = 1; page <= 20; page++) {
    const body = await authAdmin(`users?page=${page}&per_page=200`)
    const list = body.users ?? []
    out.push(...list.map(publicUser))
    if (list.length < 200) break
  }
  return out.sort((a, b) => (a.email || '').localeCompare(b.email || ''))
}

function integrationStatus(origin) {
  const vapidMissing = [!process.env.VAPID_PUBLIC_KEY && 'VAPID_PUBLIC_KEY', !process.env.VAPID_PRIVATE_KEY && 'VAPID_PRIVATE_KEY'].filter(Boolean)
  const aiMissing = [!process.env.NVIDIA_API_KEY && !process.env.ANTHROPIC_API_KEY && 'NVIDIA_API_KEY or ANTHROPIC_API_KEY'].filter(Boolean)
  return {
    google: {
      configured: googleConfigured(),
      missing: missingGoogleEnv(),
      redirectUri: `${origin}/api/google/callback`,
    },
    microsoft: {
      configured: microsoftConfigured(),
      missing: missingMicrosoftEnv(),
      redirectUri: `${origin}/api/microsoft/callback`,
    },
    vapid: {
      configured: webPushConfigured(),
      missing: vapidMissing,
    },
    apns: {
      configured: apnsConfigured(),
      missing: missingApnsEnv(),
    },
    ai: {
      configured: !!(process.env.NVIDIA_API_KEY || process.env.ANTHROPIC_API_KEY),
      missing: aiMissing,
      nvidia: !!process.env.NVIDIA_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
    },
    github: {
      configured: !!process.env.GITHUB_TOKEN,
      missing: [!process.env.GITHUB_TOKEN && 'GITHUB_TOKEN'].filter(Boolean),
    },
    resend: {
      configured: !!process.env.RESEND_API_KEY,
      missing: [!process.env.RESEND_API_KEY && 'RESEND_API_KEY'].filter(Boolean),
    },
  }
}

const handler = async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const { user, response, unconfigured } = await getUser(req)
  if (response) return response
  if (unconfigured || !user) return Response.json({ error: 'Admin needs a signed-in account.' }, { status: 501 })

  const body = await req.json().catch(() => ({}))
  const action = body?.action
  const origin = new URL(req.url).origin

  try {
    if (action === 'me') {
      if (!settingsStoreConfigured()) return Response.json({ isOwner: false })
      const owner = await ownerEmail().catch(() => null)
      const email = (user.email ?? '').trim().toLowerCase()
      return Response.json({ isOwner: !!(owner && email && email === owner) })
    }

    const gate = await requireOwner(user)
    if (gate.error) return gate.error

    if (action === 'status') return Response.json(integrationStatus(origin))

    if (action === 'listUsers') return Response.json({ users: await listUsers() })

    if (action === 'createUser') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      if (!email || !email.includes('@')) return Response.json({ error: 'A valid email is required.' }, { status: 400 })
      if (password.length < 8) return Response.json({ error: 'Temporary password must be at least 8 characters.' }, { status: 400 })
      const created = await authAdmin('users', {
        method: 'POST',
        body: JSON.stringify({ email, password, email_confirm: true }),
      })
      return Response.json({ user: publicUser(created) })
    }

    if (action === 'inviteUser') {
      const email = String(body.email ?? '').trim().toLowerCase()
      if (!email || !email.includes('@')) return Response.json({ error: 'A valid email is required.' }, { status: 400 })
      const link = await authAdmin('generate_link', {
        method: 'POST',
        body: JSON.stringify({ type: 'invite', email }),
      })
      // action_link is a one-time invite URL for the owner to copy — never log it
      return Response.json({
        email,
        actionLink: link?.action_link ?? link?.properties?.action_link ?? null,
        user: link?.user ? publicUser(link.user) : null,
      })
    }

    if (action === 'resetPassword') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = body.password != null ? String(body.password) : null
      if (!email || !email.includes('@')) return Response.json({ error: 'A valid email is required.' }, { status: 400 })
      if (password != null) {
        if (password.length < 8) return Response.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
        const users = await listUsers()
        const target = users.find(u => u.email.toLowerCase() === email)
        if (!target) return Response.json({ error: 'No account with that email.' }, { status: 404 })
        const updated = await authAdmin(`users/${target.id}`, {
          method: 'PUT',
          body: JSON.stringify({ password }),
        })
        return Response.json({ user: publicUser(updated), mode: 'set' })
      }
      const link = await authAdmin('generate_link', {
        method: 'POST',
        body: JSON.stringify({ type: 'recovery', email }),
      })
      return Response.json({
        email,
        actionLink: link?.action_link ?? link?.properties?.action_link ?? null,
        mode: 'link',
      })
    }

    if (action === 'setDisabled') {
      const userId = String(body.userId ?? '').trim()
      if (!userId) return Response.json({ error: 'userId is required.' }, { status: 400 })
      if (userId === user.id) return Response.json({ error: 'You cannot disable your own account.' }, { status: 400 })
      const disabled = !!body.disabled
      const updated = await authAdmin(`users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ ban_duration: disabled ? '876000h' : 'none' }),
      })
      return Response.json({ user: publicUser(updated) })
    }

    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    return Response.json({ error: e?.message ?? 'admin request failed' }, { status: 502 })
  }
}

export default withCors(handler)
