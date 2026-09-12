import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectCardSub } from '../components/Today'

const today = readFileSync(fileURLToPath(new URL('../components/Today.tsx', import.meta.url)), 'utf8')

describe("Today's active projects: no 0/0 row for a project with no tasks", () => {
  it('says the project is empty instead of "0/0 done"', () => {
    expect(projectCardSub({ done: 0, total: 0 })).toBe('No tasks yet')
  })

  it('keeps the count once there are tasks', () => {
    expect(projectCardSub({ done: 2, total: 5 })).toBe('2/5 done')
    expect(projectCardSub({ done: 0, total: 3 })).toBe('0/3 done')
  })

  it('keeps the target date either way', () => {
    const target = new Date(2026, 10, 30, 12).toISOString()
    expect(projectCardSub({ done: 0, total: 0 }, target)).toMatch(/^No tasks yet · target \S/)
    expect(projectCardSub({ done: 1, total: 2 }, target)).toMatch(/^1\/2 done · target \S/)
  })

  it('draws the percentage and the bar only once the project has tasks', () => {
    const cards = today.slice(today.indexOf('className="project-cards"'), today.indexOf('{sections.length === 0'))
    expect(cards).toMatch(/const started = progress\.total > 0/)
    expect(cards).toMatch(/\{started && <span className="project-card-pct">/)
    expect(cards).toMatch(/\{started && <ProgressBar /)
    expect(cards).toMatch(/projectCardSub\(progress, project\.targetAt\)/)
    expect(cards).not.toMatch(/\{progress\.done\}\/\{progress\.total\} done/)
  })
})
