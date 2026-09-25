import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Appearance } from '../components/settings/Appearance'
import { sheetSource } from './source'

/*
 * Settings' groups are one registry (SETTINGS_GROUPS in Settings.tsx): a key,
 * a label and the section components shown under it. A section shows only
 * when it draws `settings-section g-<key>` AND the stylesheet has the rule
 * that shows g-<key>. These read the source so all three stay in step — a new
 * group that forgets one fails here instead of rendering nothing.
 */

const path = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const shell = readFileSync(path('components/Settings.tsx'), 'utf8')
const files = readdirSync(path('components/settings')).filter(f => f.endsWith('.tsx'))
const sources = files.map(f => ({ file: f, text: readFileSync(path(`components/settings/${f}`), 'utf8') }))

const registry = [...shell.matchAll(/\{\s*key:\s*'([\w-]+)'[^}]*?sections:\s*\[([^\]]*)\]/g)].map(m => ({
  key: m[1],
  sections: m[2]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
}))

/** The body of `export function name`, up to the next exported function in its file. */
function componentSource(name: string): string | undefined {
  for (const { text } of sources) {
    const start = text.search(new RegExp(`export function ${name}\\(`))
    if (start < 0) continue
    const rest = text.slice(start + 1)
    const end = rest.search(/\nexport function /)
    return end < 0 ? rest : rest.slice(0, end)
  }
  return undefined
}

describe('Settings groups: one registry, every group drawn and styled', () => {
  it('reads the seven groups, in nav order, with You first', () => {
    // You is first because it is what a second member opens Settings for
    // (v3.25); the four after Household are folded behind "More…" until asked
    // for, so the dialog opens on three chips rather than six.
    expect(registry.map(g => g.key)).toEqual(['you', 'appearance', 'household', 'reminders', 'calendars', 'assistants', 'data'])
  })

  it('folds the groups that are not about you behind More…', () => {
    const advanced = [...shell.matchAll(/\{\s*key:\s*'([\w-]+)'[^}]*?advanced:\s*true/g)].map(m => m[1])
    expect(advanced).toEqual(['calendars', 'assistants', 'data'])
    // the group you are ON stays in the nav even while it is folded away,
    // or landing on it from a link would leave nothing showing as selected
    expect(shell).toContain("(!g.advanced || more || g.key === group)")
    expect(shell).toContain('More…')
  })

  it('gives every group sections that each draw settings-section g-<key>', () => {
    for (const g of registry) {
      expect(g.sections.length, g.key).toBeGreaterThan(0)
      for (const name of g.sections) {
        const body = componentSource(name)
        expect(body, `${name} is exported from components/settings/`).toBeDefined()
        expect(body, `${name} draws g-${g.key}`).toContain(`className="settings-section g-${g.key}"`)
      }
    }
  })

  it('has no section drawn under a group the registry does not list', () => {
    const keys = new Set(registry.map(g => g.key))
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/settings-section g-([\w-]+)/g)) expect(keys.has(m[1]), `${file} draws g-${m[1]}`).toBe(true)
    }
  })

  it('has a stylesheet rule that shows each group', () => {
    const sheet = sheetSource()
    for (const g of registry) expect(sheet, g.key).toContain(`.settings-body.showing-${g.key} .g-${g.key}`)
  })

  it('keeps every section mounted whichever group is showing', () => {
    // rendering only the chosen group would hold back each section's fetches until its tab is picked
    expect(shell).toMatch(/SETTINGS_GROUPS\.flatMap\(g => g\.sections\.map\(/)
    expect(shell).toContain('settings-body showing-${group}')
  })
})

describe('Settings → Appearance', () => {
  // node has no usable storage, so this is a device where nothing is stored
  const html = renderToStaticMarkup(createElement(Appearance))

  it('offers Light, Dark and Match system as one segmented choice, with Light chosen by default', () => {
    expect(html).toContain('<section class="settings-section g-appearance">')
    expect(html).toContain('<div class="segmented" role="group" aria-label="Appearance">')
    const buttons = [...html.matchAll(/<button type="button" class="([^"]+)" aria-pressed="(true|false)">([^<]+)<\/button>/g)].map(m => [m[3], m[1], m[2]])
    expect(buttons).toEqual([
      ['Light', 'seg on', 'true'],
      ['Dark', 'seg', 'false'],
      ['Match system', 'seg', 'false'],
    ])
  })

  it('says the choice stays on this device, and keeps the Match system and iPhone notes for when they apply', () => {
    expect(html).toContain('Light is the default. Your choice stays on this device, so a phone and a laptop can differ.')
    expect(html).not.toContain('Following this')
    expect(html).not.toContain('launch screen')
  })
})
