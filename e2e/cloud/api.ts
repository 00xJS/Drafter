import type { Page, Route } from '@playwright/test'
import type { Stack } from './lane'
import { lit, sqlJson } from './stack'

// Netlify's functions, answered in the page: `vite preview` serves the built
// app and nothing under /api. Each answer is the one the function gives a
// signed-in account on a host that is set up the way production is, with
// nothing connected yet — no push subscription, no calendar account, no
// assistant — so the app behaves as it does with a healthy server. The
// household is read from the stack's database, as household.mjs reads it.
//
// A call nothing here answers for gets a 501 and is listed: the test fails
// on it (fixtures.ts), so a new request the app starts making is stubbed on
// purpose rather than met by whatever preview sends back.

export interface ApiLog {
  /** Every call as "METHOD /api/name action", in order. */
  calls: string[]
  /** The calls nothing here answers for. */
  unexpected: string[]
  /** What the app sent /api/log: the client errors it would have reported to the owner. */
  reports: unknown[]
}

/** The signed-in account a request is made as, from its bearer token (src/api.ts sends it). */
interface Caller {
  id: string
  email: string
}

function callerOf(authorization: string | null): Caller | null {
  const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1]
  const claims = token?.split('.')[1]
  if (!claims) return null
  try {
    const { sub, email } = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { sub?: unknown; email?: unknown }
    return typeof sub === 'string' ? { id: sub, email: typeof email === 'string' ? email : '' } : null
  } catch {
    return null
  }
}

/** POST /api/household { action: 'status' }: describe() in household.mjs, read from the same tables. */
function householdStatus(stack: Stack, me: Caller): Promise<unknown> {
  const id = `${lit(me.id)}::uuid`
  return sqlJson(
    stack,
    `with m as (select household_id from public.household_members where user_id = ${id} limit 1),
          mine as (select display_name, avatar_media_id from public.user_settings where user_id = ${id})
     select json_build_object(
       'me', json_build_object('id', ${id}, 'email', ${lit(me.email)}, 'displayName', (select display_name from mine), 'avatar', (select avatar_media_id from mine)),
       'invites', '[]'::json,
       'household', (select json_build_object('id', h.id, 'name', h.name, 'created_by', h.created_by) from public.households h where h.id = (select household_id from m)),
       'members', coalesce((
         select json_agg(json_build_object(
                  'id', hm.user_id,
                  'email', coalesce(u.email, ''),
                  'displayName', coalesce(s.display_name, split_part(u.email, '@', 1), 'member'),
                  'avatar', s.avatar_media_id,
                  'avatarLink', null,
                  'role', hm.role,
                  'joinedAt', hm.joined_at) order by hm.joined_at)
           from public.household_members hm
           left join auth.users u on u.id = hm.user_id
           left join public.user_settings s on s.user_id = hm.user_id
          where hm.household_id = (select household_id from m)), '[]'::json));`,
  )
}

/** A POST's JSON body, or null when it has none that parses. */
function bodyOf(text: string | null): { action?: unknown; reports?: unknown } | null {
  try {
    const body = JSON.parse(text ?? '') as unknown
    return body && typeof body === 'object' ? (body as { action?: unknown; reports?: unknown }) : null
  } catch {
    return null
  }
}

/**
 * The answer to one call, or undefined for one this lane does not expect.
 * `origin` is the app's own, which the functions build their links from.
 */
async function answer(stack: Stack, method: string, name: string, action: string | undefined, me: Caller, origin: string): Promise<{ json: unknown } | undefined> {
  switch (`${method} ${name}${action ? ` ${action}` : ''}`) {
    case 'POST household status':
      return { json: await householdStatus(stack, me) }
    // useOwner: nobody in the lane is the site owner, so Admin stays out of sight
    case 'POST admin me':
      return { json: { isOwner: false } }
    // Settings → Reminders; and the unsubscribe a sign-out sends on its way out
    case 'GET push':
      return {
        json: {
          configured: true,
          missing: [],
          webPush: true,
          apns: false,
          // a key's shape, not a key: nothing in the lane subscribes
          publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
          subscriptions: [],
          digestEmail: false,
          emailConfigured: false,
          digestJournal: false,
          notifyActivity: true,
          digestHour: 8,
          timezone: null,
          sundayDraft: true,
          aiConfigured: true,
          email: me.email,
        },
      }
    case 'POST push unsubscribe':
      return { json: { ok: true, subscriptions: [] } }
    // Settings → Calendars and Email in
    case 'GET feed.ics':
      return { json: { configured: true, enabled: false, url: null, inboundUrl: null, missing: [] } }
    case 'POST google status':
      return { json: { configured: true, connected: false, email: null, missing: [], redirectUri: `${origin}/api/google/callback` } }
    case 'POST microsoft status':
      return { json: { configured: true, accounts: [], missing: [], redirectUri: `${origin}/api/microsoft/callback` } }
    // Settings → Assistants
    case 'GET agents':
      return { json: { configured: true, connections: [] } }
    // what changed on a shared task, told to the other member (src/activity.ts); the hub's notice is not written here
    case 'POST notify':
      return { json: { ok: true, notified: 0 } }
    default:
      return undefined
  }
}

/** Answer /api/* on the app's origin for this page, and keep a log of what was asked. */
export async function stubApi(page: Page, stack: Stack, origin: string): Promise<ApiLog> {
  const log: ApiLog = { calls: [], unexpected: [], reports: [] }
  await page.route(
    url => url.origin === origin && url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const request = route.request()
      const method = request.method()
      const name = new URL(request.url()).pathname.slice('/api/'.length)
      const body = method === 'POST' ? bodyOf(request.postData()) : null
      const action = typeof body?.action === 'string' ? body.action : undefined
      const call = `${method} /api/${name}${action ? ` ${action}` : ''}`
      log.calls.push(call)
      // the error reporter: kept for the test's attachments, and answered as log.mjs does
      if (method === 'POST' && name === 'log') {
        const reports = Array.isArray(body?.reports) ? body.reports : []
        log.reports.push(...reports)
        return route.fulfill({ json: { stored: reports.length } })
      }
      const me = callerOf(await request.headerValue('authorization'))
      // every function is session-gated (lib/session.mjs)
      if (!me) return route.fulfill({ status: 401, json: { error: 'Sign in first.' } })
      let out: { json: unknown } | undefined
      try {
        out = await answer(stack, method, name, action, me, origin)
      } catch (e) {
        // the lane's own failure (psql, say), not the app's: listed, so the test says so
        log.unexpected.push(`${call} failed here: ${(e as Error).message}`)
        return route.fulfill({ status: 502, json: { error: (e as Error).message } })
      }
      if (!out) {
        log.unexpected.push(call)
        return route.fulfill({ status: 501, json: { error: `${call} is not answered in the cloud lane (e2e/cloud/api.ts)` } })
      }
      return route.fulfill({ json: out.json })
    },
  )
  return log
}
