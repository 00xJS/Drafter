import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// There is one ongoing project — the owner's LIFE project — so Home and the
// Week review leave projects out entirely: no progress cards, no "stalled"
// flags, no project chips on the task rows, and nothing that starts a second
// project. Projects still exist for the Timeline and search.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const today = read('../components/Today.tsx')
const review = read('../components/Review.tsx')
const home = read('../components/planner/HomeScreen.tsx')
const ai = read('../ai.ts')

describe('Home and the Week review have no project sections', () => {
  it('Today shows no project cards, stalled line or project chips, and starts with a task', () => {
    for (const gone of ['project-cards', 'stalled-line', 'projectsForToday', 'stalledProjects', 'ProjectChip', 'onOpenProject', 'onNewProject', '+ New project']) expect(today, gone).not.toContain(gone)
    expect(today).toMatch(/<button className="btn primary" onClick=\{\(\) => onNew\(\)\}>\s*\+ New task/)
  })

  it('the Week review has no Stalled projects tile, no Projects section and no chips', () => {
    for (const gone of ['Stalled projects', 'Movement by project', 'ProjectChip', 'onOpenProject', 'projectMap']) expect(review, gone).not.toContain(gone)
  })

  it('Home hands neither page a way to open or start a project', () => {
    expect(home).not.toMatch(/onOpenProject|onNewProject|projectMap/)
  })

  it('the weekly summary is not told about projects', () => {
    const start = ai.indexOf('export async function summarizeReview')
    const fn = ai.slice(start, ai.indexOf('\nexport ', start + 10))
    expect(fn).not.toMatch(/projects|stalled/i)
  })
})
