import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previousWeekIn, shiftDayKey, zonedMidnight } from '../../netlify/functions/lib/reviewweek.mjs'
import { weekKeyOf } from '../../shared/weeks.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import { upsertSundayReview } from '../../netlify/functions/digest.mjs'

// Sunday's automatic review draft used to work out "last week" on the server's
// clock (UTC on Netlify). The digest goes out at the reader's local hour, and
// east of about UTC+8 that hour is still Saturday in UTC, so the draft was
// filed a week early — 2026-W35 instead of 2026-W36 for Tokyo on 13 September —
// where the Week segment never looks.

const iso = (ms: number) => new Date(ms).toISOString()

describe('zonedMidnight', () => {
  it('finds where a day begins in the reader’s zone', () => {
    expect(iso(zonedMidnight('2026-09-06', 'Asia/Tokyo'))).toBe('2026-09-05T15:00:00.000Z')
    expect(iso(zonedMidnight('2026-09-06', 'Europe/London'))).toBe('2026-09-05T23:00:00.000Z')
    expect(iso(zonedMidnight('2026-09-06', 'America/Los_Angeles'))).toBe('2026-09-06T07:00:00.000Z')
    expect(iso(zonedMidnight('2026-09-06', 'UTC'))).toBe('2026-09-06T00:00:00.000Z')
  })

  it('lands on the right side of a clock change', () => {
    expect(iso(zonedMidnight('2026-03-29', 'Europe/London'))).toBe('2026-03-29T00:00:00.000Z') // BST starts at 01:00
    expect(iso(zonedMidnight('2026-10-25', 'Europe/London'))).toBe('2026-10-24T23:00:00.000Z') // BST ends at 02:00
  })

  it('reads an unknown zone as UTC and refuses a malformed day', () => {
    expect(iso(zonedMidnight('2026-09-06', 'Mars/Olympus_Mons'))).toBe('2026-09-06T00:00:00.000Z')
    expect(zonedMidnight('6 Sep', 'UTC')).toBeNaN()
  })
})

describe('previousWeekIn: the week Sunday’s review is about', () => {
  // ICU writes September as "Sep" or "Sept" depending on its version; the label only reaches the prompt
  const w36 = { key: '2026-W36', label: expect.stringMatching(/^6 Sept? – 12 Sept?$/), startKey: '2026-09-06', endKey: '2026-09-13' }

  it('in Tokyo, where 8am Sunday is still Saturday in UTC — the bug', () => {
    const week = previousWeekIn(new Date('2026-09-12T23:00:00.000Z'), 'Asia/Tokyo')
    expect(week).toMatchObject(w36)
    expect(iso(week.start.getTime())).toBe('2026-09-05T15:00:00.000Z')
    expect(iso(week.end.getTime())).toBe('2026-09-12T15:00:00.000Z')
  })

  it('in London on Sunday morning and in Los Angeles on Sunday evening (Monday in UTC)', () => {
    expect(previousWeekIn(new Date('2026-09-13T07:00:00.000Z'), 'Europe/London')).toMatchObject(w36)
    const la = previousWeekIn(new Date('2026-09-14T03:00:00.000Z'), 'America/Los_Angeles')
    expect(la).toMatchObject(w36)
    expect(iso(la.start.getTime())).toBe('2026-09-06T07:00:00.000Z')
  })

  it('across the new year', () => {
    const week = previousWeekIn(new Date('2027-01-02T23:00:00.000Z'), 'Asia/Tokyo')
    expect(week).toMatchObject({ key: weekKeyOf('2026-12-27'), label: '27 Dec – 2 Jan', startKey: '2026-12-27', endKey: '2027-01-03' })
    expect(week.key).toBe('2026-W52')
  })

  it('moves day keys by whole days', () => {
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDayKey('2026-12-27', 7)).toBe('2027-01-03')
    expect(shiftDayKey('nope', 1)).toBeNull()
  })
})

describe('upsertSundayReview files the draft under the reader’s week', () => {
  const SUPABASE = 'https://db.example.test'
  let prompt = ''
  let written: Record<string, unknown>[] = []

  beforeEach(() => {
    vi.stubEnv('NVIDIA_API_KEY', 'nvidia-key')
    vi.stubEnv('SUPABASE_URL', SUPABASE)
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
    prompt = ''
    written = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (url.startsWith('https://integrate.api.nvidia.com/')) {
          prompt = body.messages.at(-1).content
          return Response.json({ choices: [{ message: { content: 'A steady week.' } }] })
        }
        if (url === `${SUPABASE}/rest/v1/rpc/sync_posts`) {
          written.push(...body.incoming)
          return Response.json({ items: [], rejected: [] })
        }
        if (url.startsWith(`${SUPABASE}/rest/v1/posts?id=eq.`)) return new Response(null, { status: 204 })
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('for a reader in Tokyo on Sunday morning', async () => {
    const items = [
      // Saturday 20:00 in Tokyo: the last evening of the week being reviewed
      { kind: 'task', id: 'fence', title: 'Fixed the fence', status: 'done', completedAt: '2026-09-12T11:00:00.000Z' },
      // the Saturday before: the week the old arithmetic reviewed instead
      { kind: 'task', id: 'gutter', title: 'Cleared the gutter', status: 'done', completedAt: '2026-09-05T11:00:00.000Z' },
    ]
    const id = await upsertSundayReview('user-one', items, new Date('2026-09-12T23:00:00.000Z'), { timezone: 'Asia/Tokyo' })
    expect(id).toBe('review-2026-W36-user-one')
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ kind: 'review', period: 'week', key: '2026-W36', summary: 'A steady week.' })
    expect(prompt).toMatch(/Period: last week \(6 Sept? – 12 Sept?\)/)
    expect(prompt).toContain('Fixed the fence')
    expect(prompt).not.toContain('Cleared the gutter')
  })

  it('names someone seen at an event of the reader’s own that week, as Review does', async () => {
    const sunday = new Date('2026-09-12T23:00:00.000Z')
    const mum = { kind: 'person', id: 'mum', name: 'Mum' }
    // Saturday lunch in Tokyo with Mum on it: no task was ever marked done
    const lunch = { kind: 'event', id: 'lunch', title: 'Lunch', start: '2026-09-12T03:00:00.000Z', end: '2026-09-12T04:00:00.000Z', allDay: false, peopleIds: ['mum'] }
    await upsertSundayReview('user-one', [mum], sunday, { timezone: 'Asia/Tokyo' })
    expect(prompt).toContain('People seen:\n- none')
    await upsertSundayReview('user-one', [mum, lunch], sunday, { timezone: 'Asia/Tokyo' })
    expect(prompt).toContain('People seen:\n- Mum')
  })
})
