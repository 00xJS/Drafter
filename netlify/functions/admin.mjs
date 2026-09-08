// Site-owner Admin API (service role): integration health, live integration
// tests, data/backup visibility, and Auth user ops.
//   POST /api/admin { action } — session-gated
//     me | status | dataStats
//     listUsers | createUser | inviteUser | resetPassword | setDisabled | deleteUser
//     listBackups | runBackup | downloadBackup
//     testAi | testPush | runDigest
// Owner = JWT email matches app_config.owner_email. Never returns secrets:
// health is configured/missing names only, tests report latency and error text,
// and push endpoints come back shortened.

import { withCors } from './lib/cors.mjs'
import { getUser, settingsGet, settingsSet, settingsStoreConfigured } from './lib/session.mjs'
import { googleConfigured, missingGoogleEnv } from './lib/google.mjs'
import { microsoftConfigured, missingMicrosoftEnv } from './lib/microsoft.mjs'
import { apnsConfigured, missingApnsEnv } from './lib/apns.mjs'
import { complete } from './lib/ai.mjs'
import { KEEP_BACKUPS, isSnapshotPath, listAllSnapshots, runBackup, signSnapshotUrl } from './lib/backup.mjs'
import { shapeDataStats } from './lib/datastats.mjs'
import { pushConfigured, sendToAll, webPushConfigured } from './push.mjs'
import { buildPeerMap, sendEmail } from './digest.mjs'
import { buildDigest, visibleItemsFor } from '../../shared/digest.mjs'

/** How long a snapshot download link stays valid. */
const DOWNLOAD_TTL_SECONDS = 300

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

/** Row count via PostgREST's content-range, without pulling the rows. */
async function count(path) {
  const e = env()
  const res = await fetch(`${e.url}/rest/v1/${path}`, {
    method: 'HEAD',
    headers: { apikey: e.key, authorization: `Bearer ${e.key}`, prefer: 'count=exact', range: '0-0' },
  })
  if (!res.ok) return null
  const m = /\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '')
  return m && m[1] !== '*' ? Number(m[1]) : null
}

/** Page through a select with Range so a big table can't be silently truncated. */
async function fetchAll(path, pageSize = 1000) {
  const out = []
  for (let from = 0; from < 200_000; from += pageSize) {
    // a range that starts past the last row answers 416 rather than an empty
    // page — on any page but the first that just means we have them all
    const page = await rest(path, { headers: { 'range-unit': 'items', range: `${from}-${from + pageSize - 1}` } }).catch(e => {
      if (from === 0) throw e
      return null
    })
    const list = Array.isArray(page) ? page : []
    out.push(...list)
    if (list.length < pageSize) break
  }
  return out
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
  return { isOwner: true, owner }
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

/** A push endpoint is a send capability, so only ever report a recognisable tail. */
function shortEndpoint(sub) {
  const ep = String(sub?.endpoint ?? '')
  if (sub?.type === 'apns') return `iOS device …${ep.slice(-6)}`
  try {
    return `${new URL(ep).host} …${ep.slice(-6)}`
  } catch {
    return `…${ep.slice(-6)}`
  }
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

/** The owner's own digest, computed exactly as the scheduled run would see it. */
async function ownerDigest(userId) {
  const settings = (await settingsGet(userId)) ?? {}
  const timezone = settings.timezone || 'UTC'
  const [rows, peers, ownerId] = await Promise.all([
    rest('posts?select=data,user_id&deleted=is.false'),
    buildPeerMap().catch(() => new Map()),
    rest('rpc/owner_user_id', { method: 'POST', body: '{}' }).catch(() => null),
  ])
  const items = visibleItemsFor(rows, userId, peers.get(userId), ownerId)
  return { settings, timezone, digest: buildDigest(items, timezone, new Date(), settings.nudged ?? {}) }
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

    if (action === 'status') {
      return Response.json({
        ...integrationStatus(origin),
        // the owner is already authenticated as the owner, so their own address is not a secret
        owner: { configured: !!gate.owner, email: gate.owner },
      })
    }

    if (action === 'dataStats') {
      const rows = await fetchAll('posts?select=user_id,deleted,synced_at,kind:data->>kind,purged:data->>purged&order=id.asc')
      const users = await listUsers().catch(() => [])
      const emails = Object.fromEntries(users.map(u => [u.id, u.email]))
      const [historyRows, households, householdMembers] = await Promise.all([
        count('posts_history?select=id').catch(() => null),
        count('households?select=id').catch(() => null),
        count('household_members?select=user_id').catch(() => null),
      ])
      return Response.json({ ...shapeDataStats(rows, { emails }), historyRows, households, householdMembers })
    }

    if (action === 'listUsers') return Response.json({ users: await listUsers(), ownerEmail: gate.owner })

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

    if (action === 'deleteUser') {
      const userId = String(body.userId ?? '').trim()
      if (!userId) return Response.json({ error: 'userId is required.' }, { status: 400 })
      if (userId === user.id) return Response.json({ error: 'You cannot delete your own account.' }, { status: 400 })
      const target = await authAdmin(`users/${userId}`).catch(() => null)
      const email = (target?.email ?? '').trim().toLowerCase()
      if (email && gate.owner && email === gate.owner) {
        return Response.json({ error: 'That is the owner account — deleting it would lock everyone out of Admin and of posts.' }, { status: 400 })
      }
      // posts.user_id is ON DELETE SET NULL, so their records survive as
      // unowned rows, which the policies then treat as the owner's
      const owned = await count(`posts?select=id&user_id=eq.${encodeURIComponent(userId)}`).catch(() => null)
      await authAdmin(`users/${userId}`, { method: 'DELETE' })
      return Response.json({ ok: true, email: target?.email ?? null, orphanedRows: owned })
    }

    if (action === 'listBackups') {
      const [snapshots, users] = await Promise.all([listAllSnapshots(), listUsers().catch(() => [])])
      const emails = Object.fromEntries(users.map(u => [u.id, u.email]))
      let lastBackupAt = null
      let totalFiles = 0
      let totalBytes = 0
      const out = snapshots.map(s => {
        const bytes = s.files.reduce((n, f) => n + f.size, 0)
        totalFiles += s.files.length
        totalBytes += bytes
        for (const f of s.files) {
          if (f.updatedAt && (!lastBackupAt || Date.parse(f.updatedAt) > Date.parse(lastBackupAt))) lastBackupAt = f.updatedAt
        }
        return { userId: s.userId, email: emails[s.userId] ?? null, bytes, files: s.files.slice(0, KEEP_BACKUPS) }
      })
      return Response.json({ users: out, totalFiles, totalBytes, lastBackupAt, keep: KEEP_BACKUPS })
    }

    if (action === 'runBackup') return Response.json(await runBackup())

    if (action === 'downloadBackup') {
      const path = String(body.path ?? '')
      if (!isSnapshotPath(path)) return Response.json({ error: 'That is not a backup path.' }, { status: 400 })
      return Response.json({ url: await signSnapshotUrl(path, DOWNLOAD_TTL_SECONDS), expiresIn: DOWNLOAD_TTL_SECONDS })
    }

    // ---- live integration tests: always 200 so the panel can show the result inline
    if (action === 'testAi') {
      const started = Date.now()
      const r = await complete({ prompt: 'Reply with the single word: ok', maxTokens: 16 }).catch(e => ({ error: e?.message ?? 'AI call threw' }))
      return Response.json({
        ok: !r.error,
        provider: r.provider ?? null,
        latencyMs: Date.now() - started,
        sample: String(r.text ?? '').slice(0, 80),
        error: r.error ?? null,
      })
    }

    if (action === 'testPush') {
      if (!pushConfigured()) return Response.json({ ok: false, error: 'Push is not configured on the host — see the VAPID / APNs cards above.' })
      const settings = (await settingsGet(user.id)) ?? {}
      const subs = Array.isArray(settings.push_subscriptions) ? settings.push_subscriptions : []
      if (!subs.length) return Response.json({ ok: false, error: 'This account has no push subscriptions — turn reminders on in Settings on a device first.' })
      const started = Date.now()
      const { gone, failed, updated } = await sendToAll(subs, { title: 'Drafter admin test', body: 'A test push from the Admin panel. Push is working.', tag: 'admin-test' })
      // mirror /api/push test: drop dead endpoints and keep discovered APNs envs
      let next = subs
      if (gone.length) next = next.filter(s => !gone.includes(s.endpoint))
      if (updated?.length) {
        const byEndpoint = new Map(updated.map(u => [u.endpoint, u]))
        next = next.map(s => byEndpoint.get(s.endpoint) ?? s)
      }
      if (next !== subs) await settingsSet(user.id, { push_subscriptions: next })
      const results = subs.map(sub => {
        const bad = failed.find(f => f.endpoint === sub.endpoint)
        if (bad) return { endpoint: shortEndpoint(sub), ok: false, status: bad.statusCode ?? 0, error: String(bad.body ?? '').slice(0, 160) }
        if (gone.includes(sub.endpoint)) return { endpoint: shortEndpoint(sub), ok: false, status: 410, error: 'expired — dropped from this account' }
        return { endpoint: shortEndpoint(sub), ok: true, status: 200, error: null }
      })
      return Response.json({ ok: results.every(r => r.ok), latencyMs: Date.now() - started, dropped: gone.length, results, error: null })
    }

    if (action === 'runDigest') {
      const send = !!body.send
      const { settings, timezone, digest } = await ownerDigest(user.id)
      const out = {
        ok: true,
        sent: false,
        timezone,
        digestHour: Number.isInteger(settings.digest_hour) ? settings.digest_hour : 8,
        lastDigestDay: settings.last_digest_day ?? null,
        lines: digest.lines,
        counts: { overdue: digest.overdue.length, dueToday: digest.dueToday.length, occasions: digest.occasions.length, peopleDue: digest.peopleDue.length },
        error: null,
      }
      if (!send) return Response.json(out)
      if (!digest.lines.length) return Response.json({ ...out, error: 'Nothing to send — the digest is empty right now.' })

      const site = process.env.URL || process.env.DEPLOY_PRIME_URL || origin
      const subs = Array.isArray(settings.push_subscriptions) ? settings.push_subscriptions : []
      let pushed = 0
      let error = null
      if (subs.length && pushConfigured()) {
        const { failed } = await sendToAll(subs, {
          title: 'Good morning — today in Drafter',
          body: digest.lines.join('\n'),
          tag: 'digest',
          url: `${site}/`,
          badge: digest.overdue.length + digest.dueToday.length,
        })
        pushed = Math.max(0, subs.length - failed.length)
        if (failed.length) error = `${failed.length} push endpoint(s) refused it (HTTP ${[...new Set(failed.map(f => f.statusCode))].join(', ')}).`
      }
      let emailed = false
      if (settings.digest_email && user.email) {
        emailed = await sendEmail(
          user.email,
          `Today in Drafter: ${digest.dueToday.length} due, ${digest.overdue.length} overdue`,
          [...digest.lines, '', `Open Drafter: ${site}/`].join('\n'),
        ).catch(() => false)
      }
      // deliberately leaves last_digest_day / nudged alone: a test send must not
      // eat the real morning digest
      return Response.json({ ...out, sent: true, pushed, emailed, error })
    }

    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    return Response.json({ error: e?.message ?? 'admin request failed' }, { status: 502 })
  }
}

export default withCors(handler)
