import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { plannerSource } from './source'
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
const planner = plannerSource()

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

  it('keeps the phone to five tabs and no More drawer', () => {
    // Board, Bills and Notes moved into the Tasks tab as segments, so the
    // catch-all sheet is gone — its data and its open-state with it.
    const bar = planner.slice(planner.indexOf('const COMPACT_TABS'), planner.indexOf('const CAL_MODE_KEY'))
    expect(bar.match(/id: '/g)).toHaveLength(5)
    expect(planner).not.toMatch(/MORE_VIEWS/)
    expect(planner).not.toMatch(/moreOpen/)
  })

  it('opens the journal on today’s editor from Today, not the stats above it', () => {
    expect(planner).toMatch(/onOpenJournal=\{\(\) => openJournal\(localDayKey\(\)\)\}/)
    // openJournal moves Home to its journal segment and opens the day asked for
    expect(planner).toMatch(/const openJournal = \([^)]*\) => \{[\s\S]*?setJournalOpenDate\(date\)[\s\S]*?setHomeTab\('journal'\)[\s\S]*?setView\('home'\)/)
  })
})

describe('one home project: the bar and its filter are gone', () => {
  it('no longer reads, writes or applies a project filter', () => {
    // a value a device saved before the update must not silently hide tasks;
    // the key is retired in retiredkeys.ts, so Planner never names it
    expect(planner).not.toMatch(/drafter:project-filter/)
    expect(planner).not.toMatch(/FILTER_KEY|projectFilter|setProjectFilter|activeFilter|filterProject|barProjects/)
    expect(planner).toMatch(/forgetRetiredKeys\(\)/)
  })

  it('has no project bar, and no view narrowed to one project', () => {
    expect(planner).not.toMatch(/project-bar|pchip/)
    expect(planner).not.toMatch(/projects=\{filterProject/)
    expect(planner.match(/projects=\{store\.projects\}/g)!.length).toBeGreaterThanOrEqual(4)
    // the only narrowing left is the household's Mine / Everyone
    expect(planner).toMatch(/const filteredTasks = useMemo\(\(\) => \{[\s\S]*?return store\.tasks\s*\}, \[store\.tasks, mineOnly, inHousehold, household\.myId\]\)/)
    expect(planner).not.toMatch(/showProject/)
  })

  it('keeps Mine / Everyone, at the right of the Tasks segment row', () => {
    expect(planner).toMatch(/className="people-tab-seg tasks-seg"[\s\S]{0,900}\{inHousehold && \([\s\S]{0,80}className="segmented mine-seg"/)
    expect([...planner.matchAll(/localStorage\.setItem\('drafter:mine-only'/g)]).toHaveLength(1)
  })

  it('keeps the switch out of the Tasks tablist, as a named group beside it', () => {
    // VoiceOver reads a tablist's children as tabs; Mine / Everyone are not
    expect(planner).toMatch(/<div className="people-tab-seg tasks-seg">\s*<span className="segmented" role="tablist" aria-label="Tasks view">/)
    expect(planner).toMatch(/className="segmented mine-seg" role="group" aria-label="Whose tasks"/)
  })

  it('says so on Home and Calendar when Mine is on, with the way off', () => {
    // Mine survives a relaunch and the launch lands on Home, where there is
    // no switch: a narrowed screen must never be a silent one
    expect(planner).toMatch(/\{inHousehold && mineOnly && \(view === 'home' \|\| view === 'calendar'\) && \(\s*<button type="button" className="mine-note" onClick=\{\(\) => setMineOnly\(false\)\}>/)
  })

  it('starts a new user with a task: there is only the one home project', () => {
    expect(today).not.toMatch(/\+ Project<\/strong>|\+ New project|onNewProject/)
    expect(today).toMatch(/<button className="btn primary" onClick=\{\(\) => onNew\(\)\}>\s*\+ New task/)
  })

  it("selects a project for Notes locally, never through a global filter", () => {
    expect(planner).toMatch(/const \[notesProjectId, setNotesProjectId\] = useState<string \| null>\(null\)/)
    expect(planner).toMatch(/onSelectProject=\{id => setNotesProjectId\(id\)\}/)
    expect(planner).toMatch(/onBack=\{\(\) => setNotesProjectId\(null\)\}/)
    // a place within a visit, not a preference: nothing persists it
    expect(planner).not.toMatch(/NOTES_PROJECT_KEY|localStorage\.setItem\('drafter:notes/)
    // "Open notes" from the project editor lands on that pad for this visit only
    expect(planner).toMatch(/onOpenNotes=\{p => \{[\s\S]*?setNotesProjectId\(p\.id\)[\s\S]*?goTasksTab\('notes'\)[\s\S]*?setView\('tasks'\)/)
    expect(planner).not.toMatch(/onOpenNotes=\{p => \{[\s\S]{0,300}setTasksTab\(/)
  })

  it('keeps "New project" reachable by typing but off the quick actions', () => {
    expect(planner).toMatch(/id: 'new-project'[^\n]*quick: false/)
  })
})

describe('a remembered segment may not hijack a destination', () => {
  /** Every place the two segment keys are written. */
  const writes = (key: string) =>
    [...planner.matchAll(new RegExp(`localStorage\\.setItem\\(${key}`, 'g'))].length

  it('writes each segment key from exactly one place', () => {
    // one persisting setter each — the segment buttons' own; every other route
    // moves the segment for the visit only. Home is deliberately not persisted.
    expect(writes('PEOPLE_TAB_KEY')).toBe(1)
    expect(writes('TASKS_TAB_KEY')).toBe(1)
    expect(planner).not.toMatch(/HOME_TAB_KEY/)
  })

  it('opens a place and the journal without pinning the segment for good', () => {
    expect(planner).toMatch(/const openPlace = \([^)]*\) => \{[^}]*goPeopleTab\('places'\)/)
    expect(planner).toMatch(/const openJournal = \([^)]*\) => \{[^}]*setHomeTab\('journal'\)/)
    expect(planner).not.toMatch(/const openPlace[\s\S]{0,240}setPeopleTab\(/)
  })

  it('sends "Open review" to Home’s Week segment', () => {
    expect(planner).toMatch(/onOpenReview=\{\(\) => setHomeTab\('week'\)\}/)
  })

  it('reaches the review as Home’s Week segment, not a tab of its own', () => {
    // Today, Review and the Journal are three segments of one Home tab now
    expect(planner).toMatch(/homeTab === 'week' && \(/)
    expect(planner).toMatch(/<Review/)
    expect(planner).not.toMatch(/view === 'review'/)
    expect(planner).not.toMatch(/view === 'today'/)
  })

  it('re-reads the remembered half when a tab bar is tapped', () => {
    // a tab tap means "wherever I left this", not "wherever a link last went" —
    // except Home, which always returns to the day
    expect(planner).toMatch(/const goView = \(v: View\) => \{[\s\S]*?goTasksTab\(storedTasksTab\(\)\)[\s\S]*?goPeopleTab\(storedPeopleTab\(\)\)/)
    expect(planner).toMatch(/if \(v === 'home'\) setHomeTab\('today'\)/)
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
    // defer and deferAll close useTaskActions, so its return ends the slice
    // (manualSync, which followed them in Planner.tsx, is in useCalendarSync)
    const from = planner.indexOf('const defer = ')
    const defer = planner.slice(from, planner.indexOf('return {', from))
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
