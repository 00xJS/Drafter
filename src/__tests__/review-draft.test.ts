import { describe, expect, it } from 'vitest'
import { reloadDraft, reviewDraft } from '../components/Review'
import type { Review } from '../types'

// Home → Week keeps drafts of the Top 3, the reflections and the summary, saved
// on blur. Plan next week writes the Top 3 into the same review from outside,
// so a draft that never reloaded showed nothing — and saved its empty lines
// back over the plan's Top 3 on the next blur.

const rec = (over: Partial<Review> = {}): Review => ({ kind: 'review', id: 'r', period: 'week', key: '2026-W37', top: [], createdAt: '2026-09-06T08:00:00.000Z', updatedAt: '2026-09-12T10:00:00.000Z', ...over })

describe('the week review’s drafts follow the saved review', () => {
  it('loads three Top 3 lines, the reflections and the summary', () => {
    expect(reviewDraft(undefined)).toEqual({ top: ['', '', ''], reflections: '', summary: '' })
    expect(reviewDraft(rec({ top: ['Boiler service'], reflections: 'Good week', summary: 'Busy' }))).toEqual({ top: ['Boiler service', '', ''], reflections: 'Good week', summary: 'Busy' })
  })

  it('reloads for another week, and when the record changes from outside', () => {
    const was = { key: '2026-W37', stamp: '2026-09-12T10:00:00.000Z' }
    expect(reloadDraft(was, { key: '2026-W38', stamp: was.stamp }, null)).toBe(true)
    // Plan next week set the Top 3, or a sync brought an edit from another device
    expect(reloadDraft(was, { key: '2026-W37', stamp: '2026-09-12T11:00:00.000Z' }, null)).toBe(true)
    // its Undo removed a review the plan had made
    expect(reloadDraft(was, { key: '2026-W37', stamp: undefined }, was.stamp)).toBe(true)
  })

  it('never reloads over its own save, or when nothing changed', () => {
    const was = { key: '2026-W37', stamp: '2026-09-12T10:00:00.000Z' }
    expect(reloadDraft(was, { key: '2026-W37', stamp: '2026-09-12T10:05:00.000Z' }, '2026-09-12T10:05:00.000Z')).toBe(false)
    expect(reloadDraft(was, was, null)).toBe(false)
  })
})
