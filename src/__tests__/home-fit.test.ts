import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

// What an iOS layout sweep of Home found at 375pt, and what keeps it fixed:
// text that ran past its card or its tile, names cut mid-letter, and targets
// under 44pt. The browser test (e2e/home-goals.spec.ts) measures the long
// goal on a phone; these hold the rules that make each fit.

const bare = sheetSource().replace(/\/\*[\s\S]*?\*\//g, '')
const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

/** The declarations of every rule whose selector list is exactly `selector`, run together. */
function rule(selector: string): string {
  const want = selector.split(',').map(s => s.trim()).join(',')
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').map(s => s.trim()).filter(Boolean).join(',') === want)
    .map(m => m[2])
    .join(';')
}

/** px from an `inset: a b c d` (or one value): how far it reaches past each edge. */
function inset(decls: string): { top: number; right: number; bottom: number; left: number } {
  const v = /inset:\s*([^;]+)/.exec(decls)![1].trim().split(/\s+/).map(x => -parseFloat(x))
  const [top, right = top, bottom = top, left = right] = v
  return { top, right, bottom, left }
}

describe('Home at 375pt: nothing runs off its card or tile', () => {
  it('keeps a briefing tile’s words inside the tile, so the ellipsis can draw', () => {
    // the phone's tile is a centred column: its text box took the line's own width
    expect(rule('.briefing-text')).toMatch(/max-width:\s*100%/)
    expect(rule('.briefing-main')).toMatch(/max-width:\s*100%/)
    expect(rule('.briefing-main')).toMatch(/text-overflow:\s*ellipsis/)
    // …and tonight's dinner, with its sides, is Home's Dinner tile now: no line of its own here
    expect(src('components/BriefingCard.tsx')).not.toMatch(/mealLabel|tonightDinner/)
  })

  it('wraps a long goal beside its box, inside the card, with → task kept at the end', () => {
    expect(rule('.goals-words-line')).toMatch(/flex:\s*1/)
    expect(rule('.goals-words-line')).toMatch(/min-width:\s*0/)
    expect(rule('.goals-words-line')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(rule('.goals-tick .dash-title')).toMatch(/white-space:\s*normal/)
    expect(rule('.btn.goals-task')).toMatch(/flex:\s*none/)
  })

  it('wraps a long goal in the review’s You said, and lets a Top 3 field give way to its → task', () => {
    expect(rule('.you-said .dash-main')).toMatch(/min-width:\s*0/)
    expect(rule('.you-said .dash-main')).toMatch(/flex:\s*1/)
    expect(rule('.you-said .dash-title')).toMatch(/white-space:\s*normal/)
    expect(rule('.review-top-row input')).toMatch(/min-width:\s*0/)
    expect(rule('.review-top-row > .btn')).toMatch(/flex:\s*none/)
  })

  it('ends a long habit’s name in an ellipsis, on the words rather than the flex box', () => {
    expect(src('components/HabitsCard.tsx')).toContain('<span className="habit-name-text">{h.name}</span>')
    const words = rule('.habit-name-text')
    expect(words).toMatch(/text-overflow:\s*ellipsis/)
    expect(words).toMatch(/overflow:\s*hidden/)
    expect(words).toMatch(/min-width:\s*0/)
    expect(rule('.habit-name')).toMatch(/white-space:\s*nowrap/)
  })
})

describe('Home at 375pt: every target is 44pt, looking as it did', () => {
  it('gives the habit tick a 44pt target round its 26px ring', () => {
    const tick = rule('.habit-tick')
    expect(tick).toMatch(/width:\s*26px/)
    expect(tick).toMatch(/position:\s*relative/)
    // a pseudo-element is placed from inside the ring's border: 26px less 2px each side
    const border = Number(/border:\s*(\d+)px/.exec(tick)![1])
    const reach = inset(rule('.habit-tick::before'))
    expect(26 - 2 * border + reach.left + reach.right).toBeGreaterThanOrEqual(44)
    expect(26 - 2 * border + reach.top + reach.bottom).toBeGreaterThanOrEqual(44)
  })

  it('makes a habit’s name a 44pt row, which its padding used to be', () => {
    expect(rule('.habit-name')).toMatch(/min-height:\s*44px/)
    expect(rule('.habit-row')).toMatch(/padding:\s*0 6px/)
  })

  it('gives a task row’s ⋯ defer handle a 44pt target, reaching no further right than the row’s padding', () => {
    const handle = rule('.swipe-handle')
    expect(handle).toMatch(/position:\s*relative/)
    expect(handle).toMatch(/padding:\s*6px 4px/)
    // the ⋯ at 15px in 6px 4px of padding measures 23 by 27 in WebKit; a little under, to be sure
    const reach = inset(rule('.swipe-handle::after'))
    expect(22.5 + reach.left + reach.right).toBeGreaterThanOrEqual(44)
    expect(26.5 + reach.top + reach.bottom).toBeGreaterThanOrEqual(44)
    // the face pads its rows 4px at the right (8px in the app), and hides what passes it
    expect(reach.right).toBeLessThanOrEqual(4)
  })
})
