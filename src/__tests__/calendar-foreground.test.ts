import { describe, expect, it } from 'vitest'
import { FOREGROUND_GAP_MS, foregroundGate } from '../calendarstate'

// Every return to the foreground refetched every subscribed feed and pulled
// every mirror, however recently it had. Coming back to the app a few minutes
// after the last fetch now waits for the half-hourly pass; pull-to-refresh
// still asks at once (and asks each feed's host fresh, calendar-feeds.test.ts).

describe('a foreground refetch at most every five minutes', () => {
  it('goes the first time, then waits out the gap after each one that went', () => {
    let clock = Date.parse('2026-09-23T08:00:00Z')
    const gate = foregroundGate(FOREGROUND_GAP_MS, () => clock)
    expect(gate.due()).toBe(true)
    gate.done()
    clock += FOREGROUND_GAP_MS - 1
    expect(gate.due()).toBe(false)
    clock += 1
    expect(gate.due()).toBe(true)
  })

  it('counts from the last fetch that went, not the last time the app came forward', () => {
    let clock = 0
    const gate = foregroundGate(FOREGROUND_GAP_MS, () => clock)
    gate.done()
    // coming forward again and again inside the gap never pushes it back
    for (let i = 0; i < 4; i++) {
      clock += 60_000
      expect(gate.due()).toBe(false)
    }
    clock += 60_000
    expect(gate.due()).toBe(true)
  })

  it('is five minutes', () => {
    expect(FOREGROUND_GAP_MS).toBe(5 * 60_000)
  })
})
