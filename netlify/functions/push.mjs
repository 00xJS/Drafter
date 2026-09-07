// Web push subscriptions and digest preferences, per user.
//   GET  /api/push            { configured, publicKey, subscriptions, digestEmail, timezone }
//   POST /api/push { action } subscribe | unsubscribe | test | prefs
// VAPID keys come from the host: `npx web-push generate-vapid-keys` →
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (+ VAPID_SUBJECT, a mailto: or https:).

import webpush from 'web-push'
import { getUser, settingsGet, settingsSet, settingsStoreConfigured } from './lib/session.mjs'

export function pushConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && settingsStoreConfigured())
}

export function configureWebPush() {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)
}

/** Send to every subscription; returns the endpoints that are gone and should be dropped. */
export async function sendToAll(subscriptions, payload) {
  configureWebPush()
  const gone = []
  await Promise.all(
    (subscriptions ?? []).map(async sub => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600 })
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(sub.endpoint)
      }
    }),
  )
  return gone
}

export default async req => {
  const { user, response, unconfigured } = await getUser(req)
  if (response) return response
  if (unconfigured || !user) return Response.json({ error: 'Push needs a signed-in account (Supabase) — not available in local mode.' }, { status: 501 })
  const configured = pushConfigured()
  const missing = [!process.env.VAPID_PUBLIC_KEY && 'VAPID_PUBLIC_KEY', !process.env.VAPID_PRIVATE_KEY && 'VAPID_PRIVATE_KEY', !settingsStoreConfigured() && 'SUPABASE_SERVICE_KEY'].filter(Boolean)

  try {
    if (req.method === 'GET') {
      const s = configured ? await settingsGet(user.id) : null
      return Response.json({
        configured,
        missing,
        publicKey: process.env.VAPID_PUBLIC_KEY ?? null,
        subscriptions: (s?.push_subscriptions ?? []).map(x => x.endpoint),
        digestEmail: !!s?.digest_email,
        timezone: s?.timezone ?? null,
        email: user.email,
      })
    }
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    if (!configured) return Response.json({ error: `Push is not configured on the host: set ${missing.join(', ')}` }, { status: 501 })
    const body = await req.json().catch(() => ({}))
    const s = (await settingsGet(user.id)) ?? {}
    const subs = Array.isArray(s.push_subscriptions) ? s.push_subscriptions : []

    if (body.action === 'subscribe') {
      const sub = body.subscription
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return Response.json({ error: 'invalid subscription' }, { status: 400 })
      const next = [...subs.filter(x => x.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null }].slice(-8)
      await settingsSet(user.id, { push_subscriptions: next, timezone: typeof body.timezone === 'string' ? body.timezone : (s.timezone ?? null) })
      return Response.json({ ok: true, subscriptions: next.map(x => x.endpoint) })
    }
    if (body.action === 'unsubscribe') {
      const next = subs.filter(x => x.endpoint !== body.endpoint)
      await settingsSet(user.id, { push_subscriptions: next })
      return Response.json({ ok: true, subscriptions: next.map(x => x.endpoint) })
    }
    if (body.action === 'test') {
      const gone = await sendToAll(subs, { title: 'Drafter', body: 'Push reminders are on. You will get a digest each morning and a nudge when timed tasks come due.', tag: 'test' })
      if (gone.length) await settingsSet(user.id, { push_subscriptions: subs.filter(x => !gone.includes(x.endpoint)) })
      return Response.json({ ok: true, sent: subs.length - gone.length })
    }
    if (body.action === 'prefs') {
      await settingsSet(user.id, {
        digest_email: !!body.digestEmail,
        timezone: typeof body.timezone === 'string' ? body.timezone : (s.timezone ?? null),
        digest_hour: Number.isInteger(body.digestHour) ? Math.min(23, Math.max(0, body.digestHour)) : (s.digest_hour ?? 8),
      })
      return Response.json({ ok: true })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    return Response.json({ error: e?.message ?? 'push settings unavailable' }, { status: e?.status === 501 ? 501 : 502 })
  }
}
