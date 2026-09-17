import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The wardrobe's midnight bug was never only the wardrobe's.
//
// Every page worked its day out with `dateKey(new Date())` or `localDayKey()`
// where it stood — right at the instant it ran, and wrong for as long as the
// page stayed mounted afterwards. On the phone that is the normal case: iOS
// suspends and resumes the WKWebView rather than killing it, so nothing forces
// a re-render at midnight and a page left open keeps yesterday.
//
// That is a display bug on a read-only card and a data bug on any card that
// WRITES with the day key. Three of them did: the wardrobe card logs a look,
// the habits card ticks a habit, the journal card saves an entry — each into
// the day before. useDayKey is the one signal that moves them all.
//
// These read the source, which is a blunt instrument, so each one is aimed at
// a specific regression: reintroducing a per-render `new Date()` day key in a
// component that writes with it.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const today = read('../components/Today.tsx')
const journal = read('../components/Journal.tsx')
const kitchen = read('../components/Kitchen.tsx')
const mealIdeas = read('../components/MealIdeasCard.tsx')
const wardrobe = read('../components/wardrobe/Wardrobe.tsx')

describe('the pages that write with a day key', () => {
  it('all take it from useDayKey, not from a fresh Date at the point of use', () => {
    for (const [name, src] of [
      ['Today', today],
      ['Journal', journal],
      ['Kitchen', kitchen],
      ['Wardrobe', wardrobe],
    ] as const) {
      expect(src, `${name} must import useDayKey`).toMatch(/from '\.\.?\/(\.\.\/)?useDayKey'/)
    }
  })

  it('Today hands one day key to every card that writes with it', () => {
    // the wardrobe card logs a look, the habits card ticks a habit, the
    // routines card ticks a step — all three took their own `new Date()`
    expect(today).toContain('const todayKey = useDayKey()')
    expect(today).toContain('dayKey={todayKey}')
    expect(today).toContain('<HabitsCard habits={habits} today={todayKey}')
    expect(today).toContain('<RoutinesCard routines={routines} today={todayKey}')
    // and the page-level key is not worked out a second way (a `new Date()`
    // inside an effect or a child is fine — both run again when this re-renders)
    expect(today).not.toMatch(/^\s*const todayKey = dateKey\(new Date\(\)\)/m)
  })

  it('the journal card and the journal page both follow the roll', () => {
    // the card is the one that saves the entry; the page lists by the same key
    expect(journal.match(/const today = useDayKey\(\)/g)).toHaveLength(2)
    expect(journal).not.toMatch(/const today = localDayKey\(\)/)
  })

  it("the Kitchen's week follows the clock, but not a week the reader stepped to", () => {
    expect(kitchen).toContain('const today = useDayKey()')
    // the same shape the wardrobe uses: move only what was still on the old day
    expect(kitchen).toMatch(/setAnchor\(a => \(dateKey\(a\) === was \? .* : a\)\)/)
    // nowhere in the file is a day key worked out a second way: the week grid
    // takes the page's `today` as a prop rather than reading its own
    expect(kitchen).not.toMatch(/const today = dateKey\(new Date\(\)\)/)
    expect(kitchen).toContain('today={today}')
  })
})

describe('"Not today" on the meal ideas card', () => {
  it('holds the day it was said, so it stops holding after midnight', () => {
    // a frozen boolean, set at 22:00, hid the card through the next whole day —
    // the one time lunch and dinner ideas are actually wanted
    expect(mealIdeas).toContain('const [dismissedDay, setDismissedDay]')
    expect(mealIdeas).toContain('dismissedDay === dayKey')
    expect(mealIdeas).toContain('setDismissedDay(dayKey)')
    expect(mealIdeas).not.toMatch(/useState\(\(\) => mealIdeasDismissed\(dayKey\)\)/)
  })
})
