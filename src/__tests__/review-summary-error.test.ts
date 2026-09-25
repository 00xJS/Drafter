import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// "✨ Write my summary" said why it failed inside the summary card, which sits
// below last week's Top 3 and the week's figures — a screen or two under the
// button on a phone — and in place of a summary already written. The failure
// now sits under the button, and the summary card only ever holds a summary.

vi.mock('../ai', async importOriginal => ({
  ...(await importOriginal<typeof import('../ai')>()),
  // thrown at once rather than after a wait, so the failure lands inside the
  // render that pressed the button (see rendered.tsx)
  summarizeReview: () => {
    throw new Error('The model is busy — try again in a minute.')
  },
}))

import { Review } from '../components/Review'
import type { Review as ReviewRecord } from '../types'
import { elements, press, settled, textOf, type El } from './rendered'

const T0 = '2026-09-13T00:00:00.000Z'
const SUMMARY = 'You finished eight things this week, which is more than it probably felt like.'
const saved: ReviewRecord = { kind: 'review', id: 'rev-1', period: 'week', key: '2026-W37', top: [], summary: SUMMARY, createdAt: T0, updatedAt: T0 }

const noop = () => {}
const props = (reviews: ReviewRecord[]) =>
  ({
    tasks: [],
    projects: [],
    people: [],
    reviews,
    journal: [],
    places: [],
    habits: [],
    onSaveReview: noop,
    onOpen: noop,
    onStatus: noop,
    onDeferAll: noop,
    onStatusAll: noop,
    onNew: noop,
  }) as unknown as Parameters<typeof Review>[0]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'))
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }), setTimeout: () => 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const all = (tree: unknown) => elements(tree as Parameters<typeof elements>[0])
const index = (tree: unknown, pick: (e: El) => boolean) => all(tree).findIndex(pick)
const actions = (e: El) => e.type === 'div' && String(e.props.className ?? '').includes('review-actions')
const card = (e: El) => e.type === 'section' && String(e.props.className ?? '').includes('review-summary')
const failure = (e: El) => e.type === 'p' && e.props.role === 'alert'

describe('a summary that could not be written', () => {
  it('says why directly under the button, before anything else on the page', () => {
    const tree = settled(Review, props([]), t => press(t, '✨ Write my summary'))
    const said = index(tree, failure)
    expect(said).toBeGreaterThan(-1)
    expect(textOf(all(tree)[said].props.children)).toBe('The model is busy — try again in a minute.')
    // the next thing after the toolbar holding the button
    const toolbar = all(tree)[index(tree, actions)]
    expect(said).toBe(index(tree, actions) + elements(toolbar).length)
    // and no empty summary card is drawn to hold it
    expect(index(tree, card)).toBe(-1)
  })

  it('leaves the summary already written where it was, readable', () => {
    const tree = settled(Review, props([saved]), t => press(t, '✨ Rewrite summary'))
    expect(index(tree, failure)).toBeLessThan(index(tree, card))
    expect(textOf(all(tree)[index(tree, card)])).toContain(SUMMARY)
    expect(textOf(all(tree)[index(tree, card)])).not.toContain('The model is busy')
  })
})
