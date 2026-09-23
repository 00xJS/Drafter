// Inbound calendar overlay: the app posts the ICS subscription URLs it manages
// (Google "secret address", iCloud share link, any webcal feed) and gets back
// concrete event instances for a window. Fetching happens here because the
// calendar hosts don't send CORS headers. Session-gated like every function.
//
// A feed is fetched through lib/icsfeed.mjs, which goes through the same
// careful transport as the recipe importer (lib/safefetch.mjs): every hop
// resolved here and pinned to a public address, redirects re-checked, a
// deadline and a size cap. It used to be a regex over the host name and
// fetch(…, { redirect: 'follow' }), which let 169.254.169.254, IPv6 and CGNAT
// addresses, names that resolve to a private network, and any redirect
// through, and read the whole body before its size check.

import { withCors } from './lib/cors.mjs'
import { expandEvents, parseICS } from '../../shared/ics.mts'
import { listEvents, toEvent } from './lib/google.mjs'
import { FeedError, feedUrl, fetchFeed } from './lib/icsfeed.mjs'
import { isOwnDrafterCalendar, listAccounts as msListAccounts, listEvents as msListEvents, toEvent as msToEvent } from './lib/microsoft.mjs'
import { getUser } from './lib/session.mjs'

const MAX_SOURCES = 12
const DAY = 86_400_000

/**
 * The /api/calendars handler. `opts` are the feed fetch's parts
 * (lib/icsfeed.mjs), which tests replace: the resolver, the transport, the cache.
 * @param {import('./lib/icsfeed.mjs').FeedOptions} [opts]
 */
export function calendarsHandler(opts = {}) {
  return async req => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    const { user, response } = await getUser(req)
    if (response) return response

    let body
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 })
    }
    const all = Array.isArray(body?.sources) ? body.sources : []
    const sources = all.slice(0, MAX_SOURCES)
    const now = Date.now()
    const from = Number.isFinite(Date.parse(body?.from)) ? Date.parse(body.from) : now - 60 * DAY
    const to = Number.isFinite(Date.parse(body?.to)) ? Date.parse(body.to) : now + 400 * DAY

    const events = []
    const errors = {}
    // Anything past the cap used to vanish and read as "0 events" in Settings.
    // Name it instead: all three Settings lists already show errors[id].
    for (const s of all.slice(MAX_SOURCES)) {
      if (s && s.id) errors[String(s.id)] = `Only ${MAX_SOURCES} calendars can be shown at once. Untick another to see this one.`
    }
    const names = {}
    // read once, and only when an Outlook calendar is asked for
    let msAccounts = null
    const outlookAccounts = () => (msAccounts ??= msListAccounts(user.id).catch(() => []))
    await Promise.all(
      sources.map(async src => {
        const id = String(src?.id ?? '')
        if (!id) return
        const raw = String(src?.url ?? '')
        if (raw.startsWith('ms:')) {
          // ms:<accountId>:<calendarId>
          const rest = raw.slice(3)
          const sep = rest.indexOf(':')
          const accountId = sep === -1 ? '' : rest.slice(0, sep)
          const calendarId = sep === -1 ? '' : rest.slice(sep + 1)
          if (!accountId || !calendarId) return
          if (!user) {
            errors[id] = 'Outlook calendars need a signed-in account'
            return
          }
          // The account's own Drafter calendar holds Drafter's mirrored entries,
          // which the grid already draws from Drafter itself: overlaid, every one
          // showed twice. Settings no longer offers it; one ticked before is
          // refused here with a reason rather than drawn.
          if (isOwnDrafterCalendar((await outlookAccounts()).find(a => a.id === accountId), calendarId)) {
            errors[id] = 'This is Drafter’s own calendar in Outlook: its entries already show here, so it is not overlaid. Untick it.'
            return
          }
          try {
            for (const item of await msListEvents(user.id, accountId, calendarId, new Date(from).toISOString(), new Date(to).toISOString())) {
              const ev = msToEvent(item, id)
              if (ev) events.push(ev)
            }
          } catch (e) {
            errors[id] = e?.message ?? 'Outlook fetch failed'
          }
          return
        }
        if (raw.startsWith('google:')) {
          const calendarId = raw.slice('google:'.length)
          if (!calendarId || calendarId === 'push') return
          if (!user) {
            errors[id] = 'Google calendars need a signed-in account'
            return
          }
          try {
            for (const item of await listEvents(user.id, calendarId, new Date(from).toISOString(), new Date(to).toISOString())) {
              const ev = toEvent(item, id)
              if (ev) events.push(ev)
            }
          } catch (e) {
            errors[id] = e?.message ?? 'Google fetch failed'
          }
          return
        }
        try {
          // a pull-to-refresh asks the feed's server; the rest may be answered from memory
          const { text } = await fetchFeed(feedUrl(raw), { ...opts, fresh: body?.fresh === true })
          const parsed = parseICS(text)
          if (parsed.calendarName) names[id] = parsed.calendarName
          for (const ev of expandEvents(parsed, from, to)) events.push({ ...ev, sourceId: id })
        } catch (e) {
          errors[id] = e instanceof FeedError ? e.message : 'Couldn’t read the calendar.'
        }
      }),
    )
    events.sort((a, b) => a.start.localeCompare(b.start))
    return Response.json({ events, errors, names, fetchedAt: new Date(now).toISOString() })
  }
}

export default withCors(calendarsHandler())
