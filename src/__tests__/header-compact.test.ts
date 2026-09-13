import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

/*
 * Landscape iPhones are 667–932pt wide, above the 640px phone breakpoint, so
 * they get the desktop header, with the notch's inset on each side. Its
 * controls want 964px (1046px with Admin), so "+ New task" ran off the right
 * edge. Up to 960px the header compacts; these pin how, and that no other
 * width sees it.
 */

const bare = sheetSource().replace(/\/\*[\s\S]*?\*\//g, '')
const topBar = readFileSync(fileURLToPath(new URL('../components/planner/TopBar.tsx', import.meta.url)), 'utf8')

/** The text between the braces of the block that opens at or after `at`. */
function blockBody(at: number): string {
  const open = bare.indexOf('{', at)
  let depth = 0
  for (let i = open; i < bare.length; i++) {
    if (bare[i] === '{') depth++
    else if (bare[i] === '}' && --depth === 0) return bare.slice(open + 1, i)
  }
  return ''
}

/** The body of every `@media` block whose query is exactly `query`. */
function media(query: string): string[] {
  return [...bare.matchAll(/@media\s*([^{]+)\{/g)].filter(m => m[1].trim().replace(/\s+/g, ' ') === query).map(m => blockBody(m.index))
}

/** The declarations of the first rule in `scope` whose selector list is exactly `selector`. */
function rule(scope: string, selector: string): string {
  const want = selector.split(',').map(s => s.trim()).join(',')
  for (const m of scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map(s => s.trim()).filter(Boolean).join(',') === want) return m[2]
  }
  return ''
}

const compact = media('(min-width: 641px) and (max-width: 960px)')
const tightest = media('(min-width: 641px) and (max-width: 759px)')

describe('landscape phones: the desktop header compacts to fit', () => {
  it('lives in one compact block and one tightest block, both above the phone breakpoint', () => {
    expect(compact).toHaveLength(1)
    expect(tightest).toHaveLength(1)
  })

  it('drops the wordmark, with the name kept on the container', () => {
    expect(rule(compact[0], '.topbar .brand > span:not(.brand-mark)')).toMatch(/display:\s*none/)
    expect(topBar).toMatch(/<div className="brand" aria-label="Drafter">/)
  })

  it('draws the tabs as icons, each label still its tab’s name', () => {
    // hidden to the eye only: display: none would take the label out of the accessible name too
    const label = rule(compact[0], '.tabs-full .tab-label')
    expect(label).toMatch(/position:\s*absolute/)
    expect(label).toMatch(/clip-path:\s*inset\(50%\)/)
    expect(label).not.toMatch(/display:\s*none/)
    const strip = topBar.slice(topBar.indexOf('<nav className="tabs tabs-full"'), topBar.indexOf('<nav className="tabs tabs-compact"'))
    expect(strip).toMatch(/<span className="tab-label">\{VIEW_LABELS\[v\]\}<\/span>/)
    // every other width shows the label: the rule exists in the compact block alone
    expect(bare.match(/\.tabs-full \.tab-label\s*\{/g)).toHaveLength(1)
  })

  it('lets the sync pill give way before the buttons do', () => {
    expect(rule(compact[0], '.sync-btn')).toMatch(/min-width:\s*0/)
    expect(rule(compact[0], '.sync-label')).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule(compact[0], '.topbar .icon-btn')).toMatch(/flex:\s*none/)
  })

  it('squares New task only where it has to, and keeps its name', () => {
    expect(rule(tightest[0], '.new-post-label')).toMatch(/display:\s*none/)
    expect(rule(tightest[0], '.new-post-btn')).toMatch(/width:\s*36px/)
    expect(rule(compact[0], '.new-post-label')).toBe('')
    expect(topBar).toMatch(/className="btn primary new-post-btn"[^\n]*aria-label="New task"/)
  })

  it('keeps the bar one 36px control tall, so --topbar-h still holds', () => {
    for (const body of [...compact, ...tightest]) {
      for (const m of body.matchAll(/(?:^|[;{\s])(height|min-height):\s*(\d+)px/g)) expect(Number(m[2]), m[0].trim()).toBeLessThanOrEqual(36)
    }
  })
})
