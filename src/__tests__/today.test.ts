import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFER_LATCH, DEFER_TRAY, DONE_PULL, DragBand, bandOf } from '../components/Today'

/**
 * The swipe row's three thresholds are the only thing the finger has to go on
 * once the eyes are elsewhere, so each one buzzes as it is crossed — once.
 */
describe("swipe bands: what letting go would do, and when it's worth a buzz", () => {
  it('is quiet in the dead zone', () => {
    expect(bandOf(0, 'none', true)).toBe('none')
    expect(bandOf(40, 'none', true)).toBe('none')
    expect(bandOf(-40, 'none', true)).toBe('none')
  })

  it('enters "done" exactly at the completion threshold', () => {
    expect(bandOf(DONE_PULL - 1, 'none', true)).toBe('none')
    expect(bandOf(DONE_PULL, 'none', true)).toBe('done')
  })

  it('enters "latch" exactly at the tray threshold', () => {
    expect(bandOf(DEFER_LATCH + 1, 'none', true)).toBe('none')
    expect(bandOf(DEFER_LATCH, 'none', true)).toBe('latch')
    // and stays latched all the way out to the parked tray
    expect(bandOf(DEFER_TRAY, 'latch', true)).toBe('latch')
  })

  it('never latches a row that cannot be deferred', () => {
    // a done row has no tray: the only thing left of centre is a snap back
    expect(bandOf(DEFER_LATCH, 'none', false)).toBe('none')
    expect(bandOf(DEFER_TRAY, 'none', false)).toBe('none')
    // and a sync that completes the task mid-drag takes the latch away too,
    // rather than leaving the face parked over a tray that no longer renders
    expect(bandOf(DEFER_TRAY, 'latch', false)).toBe('none')
    // but it can still be reopened by a pull to the right
    expect(bandOf(DONE_PULL, 'none', false)).toBe('done')
  })

  it('holds a band through small wobbles, so a thumb on the line does not rattle', () => {
    // 5px back over the line is a hand shaking, not a change of mind
    expect(bandOf(DONE_PULL - 5, 'done', true)).toBe('done')
    expect(bandOf(DEFER_LATCH + 5, 'latch', true)).toBe('latch')
  })

  it('leaves a band only once the finger is clear of it', () => {
    expect(bandOf(DONE_PULL - 11, 'done', true)).toBe('none')
    expect(bandOf(DEFER_LATCH + 11, 'latch', true)).toBe('none')
  })

  it('costs more travel to leave a band than to enter it', () => {
    // the hysteresis is what makes "buzz on entry" fire once per crossing
    const enter = DONE_PULL
    expect(bandOf(enter, 'none', true)).toBe('done')
    expect(bandOf(enter - 1, 'done', true)).toBe('done')
    expect(bandOf(enter - 1, 'none', true)).toBe('none')
  })

  it('crosses straight from one band to the other without passing through a stale one', () => {
    // a fast flick can hand touchmove a value on the far side of centre
    const bands: DragBand[] = ['none', 'done', 'latch']
    for (const prev of bands) expect(bandOf(DONE_PULL + 20, prev, true)).toBe('done')
  })
})

const today = readFileSync(fileURLToPath(new URL('../components/Today.tsx', import.meta.url)), 'utf8')
const planner = readFileSync(fileURLToPath(new URL('../components/Planner.tsx', import.meta.url)), 'utf8')

describe("Today's first screen", () => {
  it('gives every task section an anchor for the tiles to jump to', () => {
    expect(today).toMatch(/id=\{`today-\$\{sec\.key\}`\}/)
  })

  it('only makes a tile a button when its section is actually on the page', () => {
    // StatTile stays an inert div without onJump, so a tile that would scroll
    // nowhere must be handed undefined rather than a no-op handler
    expect(today).toMatch(/shown\.has\(key\)\s*\?/)
    expect(today).toMatch(/onJump=\{jump\('overdue'\)\}/)
    expect(today).toMatch(/onJump=\{jump\('today'\)\}/)
    expect(today).toMatch(/onJump=\{jump\('week'\)\}/)
  })

  it('keeps the reporting-only tiles off the phone', () => {
    // "This week" and the sparkline are ~150px of the 590px first screen
    expect(today).toMatch(/label="This week"[\s\S]{0,120}className="kpi-extra"/)
    expect(today).toMatch(/className="stat-tile kpi-extra"/)
  })

  it('offers the bulk defer next to the counter that motivates it', () => {
    const bulk = today.slice(today.indexOf('kpi-bulk'), today.indexOf('kpi-bulk') + 400)
    expect(bulk).toMatch(/onDeferAll\(s\.overdue\.map/)
    // and only when there is something to push
    expect(today).toMatch(/\{s\.overdue\.length > 0 && \(\s*<p className="kpi-bulk">/)
  })
})

describe('the journal is two taps away, and never moves under the caret', () => {
  it('decides where the card goes once, at mount', () => {
    // the editor debounces its writes; re-deciding this at 17:00 would remount
    // it and take the caret and the unsaved keystrokes with it
    expect(today).toMatch(/const \[evening\] = useState\(\(\) => new Date\(\)\.getHours\(\) >= 17\)/)
    // one element, rendered in one of two slots — never two JournalCards
    expect(today.match(/<JournalCard\b/g)).toHaveLength(1)
    expect(today).toMatch(/\{evening && journalCard\}/)
    expect(today).toMatch(/\{!evening && journalCard\}/)
  })

  it('puts the evening slot above the task sections and the morning slot below', () => {
    expect(today.indexOf('{evening && journalCard}')).toBeLessThan(today.indexOf('<div className="today-grid">'))
    expect(today.indexOf('{!evening && journalCard}')).toBeGreaterThan(today.indexOf('<div className="today-grid">'))
  })

  it('never raises the keyboard on load', () => {
    // JournalCard passes no autoFocus, so opening Today cannot steal the screen
    expect(today).not.toMatch(/autoFocus/)
  })

  it('gives the More sheet its own Journal row without a sixth tab', () => {
    expect(planner).toMatch(/key: 'journal', view: 'review'/)
    // the phone tab bar is still exactly the five it was
    const bar = planner.slice(planner.indexOf('const COMPACT_TABS'), planner.indexOf('const MORE_VIEWS'))
    expect(bar.match(/id: '/g)).toHaveLength(5)
  })

  it('lands the journal routes on today’s editor rather than the stats above it', () => {
    expect(planner).toMatch(/onOpenJournal=\{\(\) => openJournal\(localDayKey\(\)\)\}/)
    expect(planner).toMatch(/if \(m\.key === 'journal'\) openJournal\(localDayKey\(\)\)/)
    expect(planner).toMatch(/setReviewTab\('journal'\)\s*\n\s*\/\/[^\n]*\n\s*setJournalOpenDate\(localDayKey\(\)\)/)
  })
})

describe('a remembered segment may not hijack a destination', () => {
  /** Every place the two segment keys are written. */
  const writes = (key: string) =>
    [...planner.matchAll(new RegExp(`localStorage\\.setItem\\(${key}`, 'g'))].length

  it('writes each segment key from exactly one place', () => {
    // one persisting setter each — the segment buttons' own; every other route
    // moves the segment for the visit only
    expect(writes('PEOPLE_TAB_KEY')).toBe(1)
    expect(writes('REVIEW_TAB_KEY')).toBe(1)
  })

  it('opens a place and the journal without pinning the segment for good', () => {
    expect(planner).toMatch(/const openPlace = \([^)]*\) => \{[^}]*goPeopleTab\('places'\)/)
    expect(planner).toMatch(/const openJournal = \([^)]*\) => \{[^}]*goReviewTab\('journal'\)/)
    expect(planner).not.toMatch(/const openPlace[\s\S]{0,240}setPeopleTab\(/)
    expect(planner).not.toMatch(/const openJournal[\s\S]{0,200}setReviewTab\(/)
  })

  it('sends "Open review" to the review, whatever the journal was last read', () => {
    expect(planner).toMatch(/onOpenReview=\{\(\) => \{\s*goReviewTab\('review'\)\s*setView\('review'\)/)
  })

  it('sends the More sheet’s Review row to the review too', () => {
    expect(planner).toMatch(/else if \(m\.key === 'review'\) \{\s*goReviewTab\('review'\)/)
  })

  it('re-reads the remembered half when a tab bar is tapped', () => {
    // a tab tap means "wherever I left this", not "wherever a link last went"
    expect(planner).toMatch(/const goView = \(v: View\) => \{[\s\S]*?goPeopleTab\(storedPeopleTab\(\)\)[\s\S]*?goReviewTab\(storedReviewTab\(\)\)/)
    // both bars route through it
    expect(planner).toMatch(/onClick=\{\(\) => goView\(v\)\}/)
    expect(planner).toMatch(/goView\(t\.id\)/)
  })
})

const native = readFileSync(fileURLToPath(new URL('../native.ts', import.meta.url)), 'utf8')
const journal = readFileSync(fileURLToPath(new URL('../components/Journal.tsx', import.meta.url)), 'utf8')

describe('the gestures can be felt', () => {
  it('buzzes on entering a band, not on every touchmove', () => {
    expect(today).toMatch(/if \(band !== d\.band\) \{\s*d\.band = band\s*if \(band !== 'none'\) void haptic\('light'\)/)
  })

  it('loads the haptics plugin once, so the first swipe of a session is not dead', () => {
    expect(native).toMatch(/let hapticsModule/)
    expect(native).toMatch(/function loadHaptics\(\)/)
    // a failed load is not cached, or one flaky start would go silent for good
    expect(native).toMatch(/hapticsModule = null\s*\n\s*throw err/)
    // and the chunk is pulled in before a finger asks for it
    expect(native).toMatch(/void warmHaptics\(\)/)
  })

  it('confirms every defer route, since deferring has no other feedback', () => {
    const defer = planner.slice(planner.indexOf('const defer = '), planner.indexOf('const manualSync'))
    // both the single row and the "push them all" bulk
    expect(defer.match(/void haptic\('light'\)/g)).toHaveLength(2)
  })

  it('confirms a mood tap, the one-second version of journalling', () => {
    expect(journal).toMatch(/setMood\(cur => \(cur === m \? undefined : m\)\)\s*\n\s*void haptic\('light'\)/)
  })

  it('leaves the tab bar alone', () => {
    const bar = planner.slice(planner.indexOf('<nav className="tabs tabs-compact"'), planner.indexOf('<span className="spacer" />'))
    expect(bar).not.toMatch(/haptic/)
  })
})
