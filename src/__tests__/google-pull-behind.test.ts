import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { world } from './cal-world'

// A device that had not pulled from Google for weeks sent the cursor it last
// had. Google answers 410 for an updatedMin further back than it keeps
// deletions, so the pull failed, the cursor never moved, and every pull after
// it failed the same way. The window is capped now, and a 410 all the same
// starts again from a fresh week.

// Resolved at run time, not by tsc: a .d.mts beside a function would ship as a function.
const GOOGLE_FUNCTION = '../../netlify/functions/google.mjs'
const DAY = 86_400_000

let asked: string[]
/** How far back this fake Google keeps deletions: an updatedMin older than this is a 410. */
let keepsMs: number

beforeEach(() => {
  asked = []
  keepsMs = 30 * DAY
  const w = world({
    sessions: { 'session-1': { id: 'u-behind', email: 'me@example.test' } },
    googleToken: () => ({ body: { access_token: 'tok', expires_in: 3600 } }),
    google: req => {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname.endsWith('/calendars/cal-1')) return { body: { id: 'cal-1' } }
      if (req.method === 'GET' && url.pathname.endsWith('/calendars/cal-1/events')) {
        const min = url.searchParams.get('updatedMin') ?? ''
        asked.push(min)
        if (Date.now() - Date.parse(min) > keepsMs) return { status: 410, body: { error: { code: 410, message: 'The requested minimum modification time lies too far in the past.' } } }
        return {
          body: {
            items: [
              {
                id: 'g-1',
                status: 'confirmed',
                summary: 'Pay rent',
                updated: new Date(Date.now() - DAY).toISOString(),
                start: { dateTime: '2026-09-25T16:00:00Z' },
                extendedProperties: { private: { drafter: '1', taskId: 't-rent' } },
              },
            ],
          },
        }
      }
      return undefined
    },
  })
  w.rows.set('u-behind', { user_id: 'u-behind', google_refresh_token: 'grant', google_email: 'me@example.test', google_drafter_calendar_id: 'cal-1' })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function pull(since?: string) {
  const handler = (await import(/* @vite-ignore */ GOOGLE_FUNCTION)).default as (req: Request) => Promise<Response>
  const res = await handler(
    new Request('https://drafterz.netlify.app/api/google', {
      method: 'POST',
      headers: { authorization: 'Bearer session-1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pull', since }),
    }),
  )
  return { status: res.status, body: (await res.json()) as { changes?: { taskId: string }[]; at?: string; error?: string } }
}

const ago = (iso: string) => Date.now() - Date.parse(iso)

describe('a pull from a device weeks behind', () => {
  it('reads the last twenty days, not the forty since its cursor, and goes through', async () => {
    const { status, body } = await pull(new Date(Date.now() - 40 * DAY).toISOString())
    expect(status).toBe(200)
    expect(body.changes?.map(c => c.taskId)).toEqual(['t-rent'])
    expect(asked).toHaveLength(1)
    expect(ago(asked[0])).toBeGreaterThan(20 * DAY - 60_000)
    expect(ago(asked[0])).toBeLessThanOrEqual(20 * DAY + 60_000)
  })

  it('starts again from a fresh week when Google refuses even that', async () => {
    keepsMs = 10 * DAY
    const { status, body } = await pull(new Date(Date.now() - 40 * DAY).toISOString())
    expect(status).toBe(200)
    expect(body.changes?.map(c => c.taskId)).toEqual(['t-rent'])
    expect(asked).toHaveLength(2)
    expect(ago(asked[1])).toBeGreaterThan(7 * DAY - 60_000)
    expect(ago(asked[1])).toBeLessThanOrEqual(7 * DAY + 60_000)
    // the answer moves the device's cursor on, so the next pull is an ordinary one
    expect(ago(body.at!)).toBeLessThan(60_000)
  })

  it('uses a recent cursor as it is, and a missing one as a week', async () => {
    const since = new Date(Date.now() - 2 * DAY).toISOString()
    await pull(since)
    await pull(undefined)
    expect(asked[0]).toBe(since)
    expect(ago(asked[1])).toBeGreaterThan(7 * DAY - 60_000)
    expect(ago(asked[1])).toBeLessThanOrEqual(7 * DAY + 60_000)
  })
})
