import { describe, expect, it } from 'vitest'
import { defaultReviewAnchor, weekRange } from '../review'

describe('weekRange', () => {
  it('runs Sunday through Saturday', () => {
    const sunday = new Date(2026, 8, 6, 12, 0, 0)
    expect(sunday.getDay()).toBe(0)
    const r = weekRange(sunday)
    expect(r.start.getDay()).toBe(0)
    expect(r.end.getTime() - r.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
    expect(r.start.getDate()).toBe(6)
    expect(r.end.getDate()).toBe(13)
  })
})

describe('defaultReviewAnchor', () => {
  it('anchors to the previous week on Sunday', () => {
    const sunday = new Date(2026, 8, 6, 15, 0, 0)
    expect(sunday.getDay()).toBe(0)
    const anchor = defaultReviewAnchor(sunday)
    const range = weekRange(anchor)
    expect(range.start.getDate()).toBe(30)
    expect(range.end.getDate()).toBe(6)
    expect(range.start.getMonth()).toBe(7)
  })

  it('anchors to the previous week when less than one day of the range has elapsed', () => {
    const sundayMorning = new Date(2026, 8, 6, 6, 0, 0)
    const anchor = defaultReviewAnchor(sundayMorning)
    expect(weekRange(anchor).start.getDate()).toBe(30)
  })

  it('uses today mid-week', () => {
    const wednesday = new Date(2026, 8, 9, 12, 0, 0)
    expect(wednesday.getDay()).toBe(3)
    expect(defaultReviewAnchor(wednesday).getDate()).toBe(9)
  })
})
