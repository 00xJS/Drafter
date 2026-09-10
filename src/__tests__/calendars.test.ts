import { describe, expect, it } from 'vitest'
import { GOOGLE_PUSH_ID, googlePushId, mirrorToggle } from '../calendars'

// The Google mirror switch used to migrate the legacy shared `google-push` row
// only while turning mirroring ON. Turning it OFF wrote a fresh per-user row
// with enabled:false and left the legacy row enabled — and Planner decides
// whether to run the mirror with
//   some(c => (c.id === myPushId || c.id === GOOGLE_PUSH_ID) && c.enabled)
// so the switch read off while tasks kept flowing into Google Calendar.

const ME = '00000000-0000-0000-0000-0000000000aa'
const MINE = googlePushId(ME)
const legacy = { id: GOOGLE_PUSH_ID, updatedAt: '2026-09-01T00:00:00.000Z' }
const mine = { id: MINE, updatedAt: '2026-09-01T00:00:00.000Z' }

describe('mirrorToggle', () => {
  it('drops the legacy row when turning mirroring OFF, not just on', () => {
    const off = mirrorToggle(legacy, MINE, false)
    expect(off.removeId).toBe(GOOGLE_PUSH_ID)
    expect(off.write).toBe('fresh')
  })

  it('drops the legacy row when turning mirroring ON', () => {
    const on = mirrorToggle(legacy, MINE, true)
    expect(on.removeId).toBe(GOOGLE_PUSH_ID)
    expect(on.write).toBe('fresh')
  })

  it('leaves a row that already carries the per-user id alone', () => {
    for (const on of [true, false]) {
      const plan = mirrorToggle(mine, MINE, on)
      expect(plan.removeId).toBeUndefined()
      expect(plan.write).toBe('existing')
    }
  })

  it('creates a row only when turning on with nothing stored', () => {
    expect(mirrorToggle(undefined, MINE, true)).toEqual({ write: 'fresh' })
    expect(mirrorToggle(undefined, MINE, false)).toEqual({ write: 'none' })
  })

  it('is a no-op rename when the account has no household id', () => {
    // myPushId falls back to GOOGLE_PUSH_ID, so the legacy row IS the row
    const plan = mirrorToggle(legacy, GOOGLE_PUSH_ID, false)
    expect(plan.removeId).toBeUndefined()
    expect(plan.write).toBe('existing')
  })

  it('never removes a row it is not replacing', () => {
    const plan = mirrorToggle(mine, MINE, false)
    expect(plan.removeId).toBeUndefined()
  })
})
