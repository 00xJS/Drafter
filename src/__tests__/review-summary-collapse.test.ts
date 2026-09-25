import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Review, wordCount } from '../components/Review'
import type { Review as ReviewRecord } from '../types'
import { button, elements, settled, textOf } from './rendered'

// The summary card had no way to shut it. That did not matter while a summary
// was 150 words; it mattered a great deal the week one came back as 600 words
// of the model talking to itself, sitting between the week's figures and
// everything the week actually held.
//
// These used to be substring greps of Review.tsx, which is no test at all: a
// review of the whole app pointed out that changing `onClick={toggleSummary}`
// to `onClick={() => {}}` left every assertion passing while the button did
// nothing. They drive the component now.

const T0 = '2026-09-13T00:00:00.000Z'
const SUMMARY =
  'You finished eight things this week, which is more than it probably felt like. The report for Invitation Homes slipped again.\n\n- Get the report sent\n- Book the oil change'

const saved: ReviewRecord = {
  kind: 'review',
  id: 'rev-1',
  period: 'week',
  key: '2026-W37',
  top: [],
  summary: SUMMARY,
  createdAt: T0,
  updatedAt: T0,
}

const noop = () => {}
const props = {
  tasks: [],
  projects: [],
  people: [],
  reviews: [saved],
  journal: [],
  places: [],
  habits: [],
  onSaveReview: noop,
  onOpen: noop,
  onStatus: noop,
  onDeferAll: noop,
  onStatusAll: noop,
  onNew: noop,
}

let store: Record<string, string>

beforeEach(() => {
  vi.useFakeTimers()
  // inside the week the saved review belongs to, so the page opens on it
  vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'))
  store = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    },
  })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }), setTimeout: () => 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const view = (act?: (tree: ReturnType<typeof settled>) => void) =>
  settled(Review, props as unknown as Parameters<typeof Review>[0], act as (tree: unknown) => void)

const toggle = (tree: ReturnType<typeof settled>) =>
  elements(tree).find(e => e.type === 'button' && String(e.props.className ?? '').includes('review-summary-toggle'))

describe('wordCount', () => {
  it('counts words, not characters, and reads nothing as nothing', () => {
    expect(wordCount('One two three')).toBe(3)
    expect(wordCount('  spaced \n out  ')).toBe(2)
    expect(wordCount('')).toBe(0)
    expect(wordCount('   ')).toBe(0)
  })
})

describe('the summary card', () => {
  it('shows the summary, open, with a Hide that says which way it goes', () => {
    const tree = view()
    expect(textOf(tree)).toContain('The report for Invitation Homes slipped again.')
    const t = toggle(tree)
    expect(t?.props['aria-expanded']).toBe(true)
    expect(textOf(t)).toBe('Hide')
  })

  it('puts the summary away when Hide is pressed, and says how much is behind it', () => {
    const shut = view(tree => (toggle(tree)!.props.onClick as () => void)())
    expect(textOf(shut)).not.toContain('The report for Invitation Homes slipped again.')
    expect(toggle(shut)?.props['aria-expanded']).toBe(false)
    expect(textOf(toggle(shut))).toBe('Show')
    expect(textOf(shut)).toContain(`${wordCount(SUMMARY)} words, hidden`)
  })

  it('remembers the choice on this device', () => {
    view(tree => (toggle(tree)!.props.onClick as () => void)())
    expect(store['drafter:review-summary']).toBe('0')
  })

  it('opens by default for a reader who has never touched it', () => {
    expect(toggle(view())?.props['aria-expanded']).toBe(true)
    // and stays shut for one who has
    store['drafter:review-summary'] = '0'
    expect(toggle(view())?.props['aria-expanded']).toBe(false)
  })

  it('still offers to write one, whether the card is open or shut', () => {
    expect(() => button(view(), '✨ Rewrite summary')).not.toThrow()
  })
})
