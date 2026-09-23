import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { doneMonths, taskReport, workDone } from '../lensstats'
import type { Task } from '../types'

// Findings from the whole-app review, each confirmed by three verifiers before
// it was touched. One test per defect, aimed at the thing that was wrong.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const NOW = new Date('2026-09-17T12:00:00.000Z')

const task = (id: string, completedAt: string, tags: string[] = []): Task =>
  ({
    kind: 'task',
    id,
    title: id,
    status: 'done',
    priority: 'normal',
    tags,
    completedAt,
    createdAt: completedAt,
    updatedAt: completedAt,
  }) as Task

// A logged visit is a done task tagged 'visit'. It is finished, but it is not
// work, and the app has one rule about that — workDone in src/lensstats.ts.
const visit = (id: string, at: string) => task(id, at, ['visit'])

describe('Stats figures read the app’s own rule for what counts as finished', () => {
  const tasks = [
    task('real-1', '2026-03-04T10:00:00.000Z'),
    visit('saw-mum', '2026-03-11T10:00:00.000Z'),
    visit('saw-dad', '2026-03-12T10:00:00.000Z'),
    visit('bbq', '2026-03-13T10:00:00.000Z'),
    visit('lunch', '2026-03-14T10:00:00.000Z'),
  ]

  it('workDone is the rule, and it leaves logged visits out', () => {
    expect(workDone(tasks).map(t => t.id)).toEqual(['real-1'])
  })

  it("Overview's sparkline shows the same twelve numbers as the Tasks segment's bars", () => {
    // it counted every done task, so March read 5 on the card and 1 in the
    // segment the card opens — a quiet month of catch-ups drawn as a busy
    // month of work
    const months = doneMonths(tasks, 2026, NOW).months
    expect(months[2]).toBe(1)
    expect(read('../components/StatsLens.tsx')).toContain('doneMonths(tasks, year, now).months')
    expect(read('../components/StatsLens.tsx')).not.toMatch(/monthBuckets\(tasks\.filter/)
  })

  it("the year grid counts the days the streak line above it counts", () => {
    // the tiles and the streak come from taskReport -> workDone; the grid had
    // its own loop with no visit test, so it lit four extra cells
    const report = taskReport(tasks, 'all', NOW)
    expect(report.streaks.best).toBe(1)
    const src = read('../components/StatsLens.tsx')
    expect(src).toMatch(/for \(const t of workDone\(tasks\)\)/)
    expect(src).not.toMatch(/t\.status !== 'done' \|\| !t\.completedAt\) continue/)
  })
})

describe('the recipe quantity box', () => {
  const src = read('../components/Kitchen.tsx')

  it('holds what was typed, so a decimal survives the next keystroke', () => {
    // it rendered the PARSED number: "0" -> 0 -> "0", then "." made "0." which
    // parses to 0, so React drove the box back to "0" and ate the point, and
    // "5" landed as 5. Half a cup saved as five, silently, into the grocery list.
    expect(src).toContain('const [qtyText, setQtyText]')
    expect(src).toContain('value={qtyText[ing.id] ?? (ing.qty != null ? String(ing.qty) : \'\')}')
    expect(src).not.toMatch(/value=\{ing\.qty \?\? ''\}/)
  })

  it('stores nothing rather than a number it cannot trust', () => {
    // matching parseIngredients in src/ai.ts: finite, positive, and sane
    expect(src).toMatch(/Number\.isFinite\(n\) && n > 0 && n <= 10_000/)
  })
})

describe('the app lock', () => {
  const src = read('../components/LockGate.tsx')

  it('watches for a resume even when the lock is off at mount', () => {
    // the effect runs once, and iOS resumes the page rather than reloading it,
    // so switching the lock on in Settings left nothing listening: it did not
    // engage until the next cold start
    const watch = src.indexOf('watchAppLock(')
    const guard = src.indexOf('if (!appLockEnabled())')
    expect(watch).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(watch)
  })

  it('makes the planner behind it inert, so Enter cannot press a hidden button', () => {
    // the overlay was opaque but only paint: the planner kept its place in the
    // tab order and the accessibility tree underneath
    expect(src).toContain('el.inert = locked')
    expect(src).toContain('card.current?.focus')
  })
})

describe('removing a household member', () => {
  const src = read('../../netlify/functions/household.mjs')

  it('checks the account is in this household before touching anything of theirs', () => {
    expect(src).toContain('household_members?household_id=eq.${m.household_id}&user_id=eq.${target}&select=user_id&limit=1')
    expect(src).toContain('not in your household')
  })

  it('re-attributes the shared work only, by the one list of personal kinds', () => {
    expect(src).toContain("import { PERSONAL_KINDS } from '../../shared/kinds.mts'")
    // notes are excluded here and moved by a statement of their own, so a
    // private one never travels (v3.16, v3.19 — srv-household.test.ts drives it)
    expect(src).toContain("kind=not.in.(${[...PERSONAL_KINDS, 'note'].join(',')})")
  })

  it('no longer swallows a failed re-attribution', () => {
    expect(src).not.toMatch(/JSON\.stringify\(\{ user_id: ownerId \}\),\s*\}\)\.catch/)
  })
})
