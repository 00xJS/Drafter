import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFTER_DESCRIPTION, googleCalendarRow } from '../../netlify/functions/lib/google.mjs'
import { graphCalendarRow, isOwnDrafterCalendar } from '../../netlify/functions/lib/microsoft.mjs'
import { disconnectOutlook, outlookSourcesFor } from '../calendars'
import type { CalendarSource } from '../types'
import { world } from './cal-world'

// Two small Settings bugs. Ticking an Outlook account's own Drafter calendar
// as an overlay drew every mirrored entry twice (once from Drafter, once from
// Outlook); and Microsoft disconnect removed this device's rows before the
// server call, so a refused disconnect looked done.

// Resolved at run time, not by tsc: a .d.mts beside a function would ship as a function.
const CALENDARS_FUNCTION = '../../netlify/functions/calendars.mjs'

const TASK_PROP = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name drafterTaskId'

describe('Drafter’s own calendar is marked, so the picker can leave it out', () => {
  it('Outlook: the account’s stored Drafter calendar, and nothing else', () => {
    expect(graphCalendarRow({ id: 'cal-d', name: 'Drafter', canEdit: true }, 'cal-d')).toMatchObject({ drafter: true, writable: true })
    expect(graphCalendarRow({ id: 'cal-a', name: 'Calendar', isDefaultCalendar: true }, 'cal-d')).toMatchObject({ drafter: false, primary: true })
    // never mirrored into: nothing of Drafter's is there to show twice
    expect(graphCalendarRow({ id: 'cal-d', name: 'Drafter' }, null).drafter).toBe(false)
    expect(isOwnDrafterCalendar({ drafterCalendarId: 'cal-d' }, 'cal-d')).toBe(true)
    expect(isOwnDrafterCalendar({ drafterCalendarId: null }, 'cal-d')).toBe(false)
    expect(isOwnDrafterCalendar(undefined, 'cal-d')).toBe(false)
  })

  it('Google: the stored one, or one that is ours by title or description', () => {
    expect(googleCalendarRow({ id: 'g-1', summary: 'Anything', accessRole: 'owner' }, 'g-1').drafter).toBe(true)
    expect(googleCalendarRow({ id: 'g-2', summary: 'Drafter', accessRole: 'owner' }, null).drafter).toBe(true)
    expect(googleCalendarRow({ id: 'g-3', summary: 'Tasks', description: DRAFTER_DESCRIPTION, accessRole: 'owner' }, null).drafter).toBe(true)
    // someone else's calendar that happens to be called Drafter is theirs to show
    expect(googleCalendarRow({ id: 'g-4', summary: 'Drafter', accessRole: 'reader' }, null).drafter).toBe(false)
    expect(googleCalendarRow({ id: 'g-5', summary: 'Family', summaryOverride: 'Home', accessRole: 'owner' }, null)).toMatchObject({ name: 'Home', drafter: false })
  })
})

describe('the overlay refuses an Outlook Drafter calendar ticked before', () => {
  beforeEach(() => {
    world({
      sessions: { 'session-1': { id: 'u-overlay', email: 'me@example.test' } },
      msToken: () => ({ body: { access_token: 'tok', expires_in: 3600, refresh_token: 'r1' } }),
      graph: req =>
        req.url.includes('/me/calendars/cal-a/calendarView')
          ? {
              body: {
                value: [
                  { id: 'm1', subject: 'Swimming', start: { dateTime: '2026-09-14T17:00:00.0000000' }, end: { dateTime: '2026-09-14T18:00:00.0000000' }, isAllDay: false },
                  {
                    id: 'm2',
                    subject: 'Pay rent',
                    start: { dateTime: '2026-09-15T09:00:00.0000000' },
                    end: { dateTime: '2026-09-15T10:00:00.0000000' },
                    isAllDay: false,
                    singleValueExtendedProperties: [{ id: TASK_PROP, value: 't1' }],
                  },
                ],
              },
            }
          : undefined,
    }).rows.set('u-overlay', { user_id: 'u-overlay', microsoft_accounts: [{ id: 'acct', email: 'me@example.test', refreshToken: 'r1', drafterCalendarId: 'cal-drafter' }] })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('says why instead of drawing each entry twice, and still draws the rest', async () => {
    const handler = (await import(/* @vite-ignore */ CALENDARS_FUNCTION)).default as (req: Request) => Promise<Response>
    const res = await handler(
      new Request('https://drafterz.netlify.app/api/calendars', {
        method: 'POST',
        headers: { authorization: 'Bearer session-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          sources: [
            { id: 's-drafter', url: 'ms:acct:cal-drafter' },
            { id: 's-a', url: 'ms:acct:cal-a' },
          ],
          from: '2026-09-01T00:00:00.000Z',
          to: '2026-10-01T00:00:00.000Z',
        }),
      }),
    )
    const body = (await res.json()) as { events: { id: string; title: string }[]; errors: Record<string, string> }
    expect(body.errors['s-drafter']).toMatch(/Drafter’s own calendar/)
    expect(body.errors['s-a']).toBeUndefined()
    // the ordinary calendar still overlays, minus Drafter's own mirrored task
    expect(body.events.map(e => e.title)).toEqual(['Swimming'])
  })
})

describe('Microsoft disconnect: the server first', () => {
  const row = (id: string, url: string): CalendarSource => ({ kind: 'calendar', id, name: id, url, color: '#000', enabled: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })
  const sources = [row('overlay', 'ms:acct:cal-a'), row('mirror', 'ms-push:acct'), row('other-overlay', 'ms:acct-2:cal-b'), row('other-mirror', 'ms-push:acct-2'), row('ics', 'https://example.test/cal.ics')]

  it('a refused disconnect changes nothing here, and says why', async () => {
    const removed: string[] = []
    await expect(
      disconnectOutlook('acct', sources, id => removed.push(id), async () => {
        throw new Error('The server is unreachable from here.')
      }),
    ).rejects.toThrow('unreachable')
    expect(removed).toEqual([])
  })

  it('once the server has let go, removes that account’s rows and no other account’s', async () => {
    const removed: string[] = []
    const calls: unknown[] = []
    await disconnectOutlook('acct', sources, id => removed.push(id), async (name, payload) => {
      calls.push([name, payload])
      return { accounts: [] }
    })
    expect(calls).toEqual([['disconnect', { accountId: 'acct' }]])
    // the old match was url.includes(accountId), which took acct-2's rows too
    expect(removed.sort()).toEqual(['mirror', 'overlay'])
    expect(outlookSourcesFor('acct-2', sources).map(s => s.id).sort()).toEqual(['other-mirror', 'other-overlay'])
  })
})
