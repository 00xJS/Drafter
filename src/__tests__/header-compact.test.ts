import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

/*
 * Landscape iPhones are 667–932pt wide, above the 640px phone breakpoint, so
 * they get the desktop header, with the notch's inset on each side. Its
 * controls want 1052px (1135px with Admin), so "+ New task" ran off the right
 * edge. Up to 960px the header compacts to icons; from 961px it sheds only the
 * wordmark, the wide gaps and the sync pill's width, keeping the tab labels.
 * These pin how, and that no other width sees it.
 *
 * The two numbers were measured in a browser on 2026-09-16 with six tabs (sum
 * .topbar's children, its gaps and its padding above 1134px, with an .admin-btn
 * injected — local mode renders none). They were 964/1046 with five tabs; the
 * Stats tab added 88px, which is why the shed range below is no longer the
 * owner's alone. Re-measure if a control is ever added to the header.
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

  it('sheds the first things for EVERY window from 961px to 1051px, tab labels kept', () => {
    // With five tabs the strip wanted 964px and only the owner's Admin pushed
    // it past 961, so this was scoped to `.topbar:has(.admin-btn)`. The sixth
    // tab made it everyone's: between 961 and 1051 an ordinary header's search
    // and settings flex-squashed to 21px.
    const shed = media('(min-width: 961px) and (max-width: 1051px)')
    expect(shed).toHaveLength(1)
    expect(rule(shed[0], '.topbar .brand > span:not(.brand-mark)')).toMatch(/display:\s*none/)
    expect(rule(shed[0], '.topbar .icon-btn')).toMatch(/flex:\s*none/)
    expect(rule(shed[0], '.topbar .sync-label')).toMatch(/text-overflow:\s*ellipsis/)
    // it is not the owner's alone any more, and the tabs and New task keep their words
    for (const m of shed[0].matchAll(/([^{}]+)\{/g)) expect(m[1].trim()).toMatch(/^\.topbar(?!:has)/)
    expect(shed[0]).not.toMatch(/tab-label|new-post/)
  })

  it('carries the owner, whose Admin button is 83px more, a further 83px to 1134px', () => {
    const owner = media('(min-width: 1052px) and (max-width: 1134px)')
    expect(owner).toHaveLength(1)
    expect(rule(owner[0], '.topbar:has(.admin-btn) .brand > span:not(.brand-mark)')).toMatch(/display:\s*none/)
    expect(rule(owner[0], '.topbar:has(.admin-btn) .icon-btn')).toMatch(/flex:\s*none/)
    expect(rule(owner[0], '.topbar:has(.admin-btn) .sync-label')).toMatch(/text-overflow:\s*ellipsis/)
    // every rule here is the owner's alone; below 1052px the block above covers them
    for (const m of owner[0].matchAll(/([^{}]+)\{/g)) expect(m[1].trim()).toMatch(/^\.topbar:has\(\.admin-btn\)/)
    expect(owner[0]).not.toMatch(/tab-label|new-post/)
    expect(topBar).toMatch(/className="btn subtle admin-btn"/)
  })

  it('leaves no width between 641px and 1134px where the icon buttons can squash', () => {
    // the three ranges have to meet exactly, with no gap: 641–960, 961–1051,
    // 1052–1134 (the last the owner's). A gap is where search and settings
    // shrink below their 36px square.
    // (641–759 is the tightest block, nested inside the first; it squares New
    // task and is not one of the three that protect the icon buttons.)
    const steps: [number, number][] = [
      [641, 960],
      [961, 1051],
      [1052, 1134],
    ]
    for (const [lo, hi] of steps) expect(media(`(min-width: ${lo}px) and (max-width: ${hi}px)`), `${lo}–${hi}`).toHaveLength(1)
    for (let i = 1; i < steps.length; i++) expect(steps[i][0], `gap after ${steps[i - 1][1]}px`).toBe(steps[i - 1][1] + 1)
    // and each of the three keeps the icon buttons square
    for (const [lo, hi] of steps) {
      const body = media(`(min-width: ${lo}px) and (max-width: ${hi}px)`)[0]
      expect(body, `${lo}–${hi} must keep .icon-btn square`).toMatch(/\.icon-btn \{\s*flex: none/)
    }
  })

  it('keeps the bar one 36px control tall, so --topbar-h still holds', () => {
    for (const body of [...compact, ...tightest]) {
      for (const m of body.matchAll(/(?:^|[;{\s])(height|min-height):\s*(\d+)px/g)) expect(Number(m[2]), m[0].trim()).toBeLessThanOrEqual(36)
    }
  })
})
