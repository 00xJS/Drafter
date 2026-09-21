import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrast, mixHex, ON_DEEP_USER, ON_USER, parseHex } from '../contrast'
import { GITHUB_STATE_META } from '../github'
import { SEEN_META } from '../people'
import { THEME_GROUND, THEME_HEX } from '../theme'
import { PRIORITY_META, PROJECT_STATUS_META, STATUS_META } from '../types'
import { sheetImports } from './source'

/*
 * The two palettes in src/styles/01-base.css: light on the bare :root, dark on
 * :root[data-theme='dark']. These pin the shape (every themed token in both,
 * the fixed ones once), hold dark to exactly what shipped until 2026-09-14,
 * compute the light palette's contrast, and keep the copies other code holds
 * (THEME_GROUND, THEME_HEX, the contrast helpers' inks) equal to the sheet.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../styles/${rel}`, import.meta.url)), 'utf8')
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const base = strip(read('01-base.css'))

/** The declarations of the one rule in 01-base.css whose selector is exactly `selector`, whitespace collapsed. */
function block(selector: string): Record<string, string> {
  const rules = [...base.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].trim() === selector)
  expect(rules, selector).toHaveLength(1)
  return Object.fromEntries([...rules[0][2].matchAll(/([-\w]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim().replace(/\s+/g, ' ')]))
}

const light = block(':root')
const dark = block(":root[data-theme='dark']")
const props = (b: Record<string, string>) => Object.keys(b).filter(k => k.startsWith('--'))

/** Tokens that are not colours; they live on the bare :root only. */
const NON_COLOUR = ['--type-scale', '--radius-sm', '--radius', '--radius-lg', '--radius-xl', '--tabbar-h', '--touch', '--topbar-h', '--fab-size', '--safe-b', '--safe-l', '--safe-r', '--keyboard-h']

/** Colours that are the same in both themes, declared once on :root, at the value dark has always painted. */
const FIXED: Record<string, string> = {
  '--accent': '#f97316',
  '--on-accent': '#1a1206',
  '--glow-accent': '0 2px 14px color-mix(in srgb, var(--accent) 30%, transparent)',
  '--accent-bright': '#fb923c', // .brand-mark's first stop, var(--accent-hover) in dark
  '--accent-deep': '#e2620a', // .brand-mark's last stop
  '--on-media': '#ffffff', // .media-remove's #fff
  '--media-scrim': 'rgba(11, 11, 11, 0.6)',
  '--sheen': 'rgba(255, 255, 255, 0.25)',
  '--on-user-color': '#0f1115', // .person-avatar's --inverse-text in dark
  '--on-deep-user-color': '#ffffff',
  '--mark-bg': 'color-mix(in srgb, var(--accent) 28%, transparent)', // rgba(249, 115, 22, 0.28)
  '--photo-white': '#ffffff', // the garment cut-out's ground: the product image, white in both
}

/**
 * The dark palette as it shipped until 2026-09-14 (81435a1), and each new token
 * at the literal or token it replaces there. A change here is a change to what
 * a Dark reader sees. The few inks that did not read are in DARK_CHANGED instead.
 */
const DARK: Record<string, string> = {
  'color-scheme': 'dark',
  // the themed colour tokens that already existed
  '--bg': '#0c0e12',
  '--surface': '#15181f',
  '--surface-2': '#1e222b',
  '--surface-3': '#272c37',
  '--border': '#2a2f3a',
  '--border-strong': '#3a4150',
  '--hairline': 'rgba(255, 255, 255, 0.06)',
  '--text': '#edeff3',
  '--text-2': '#a9b0be',
  '--accent-hover': '#fb923c',
  '--accent-soft': 'color-mix(in srgb, var(--accent) 15%, transparent)',
  '--accent-softer': 'color-mix(in srgb, var(--accent) 9%, transparent)',
  '--accent-ring': 'color-mix(in srgb, var(--accent) 34%, transparent)',
  '--accent-text': '#fca560',
  '--danger': '#f87171',
  '--inverse-bg': '#e7e9ee',
  '--inverse-text': '#0f1115',
  '--ok': '#4ade80',
  '--warn-bg': 'rgba(245, 158, 11, 0.16)',
  '--warn-text': '#fcd34d',
  '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.35)',
  '--shadow': '0 1px 2px rgba(0, 0, 0, 0.34), 0 3px 8px rgba(0, 0, 0, 0.24)',
  '--shadow-md': '0 2px 4px rgba(0, 0, 0, 0.3), 0 8px 20px rgba(0, 0, 0, 0.34)',
  '--shadow-lg': '0 4px 8px rgba(0, 0, 0, 0.32), 0 18px 44px rgba(0, 0, 0, 0.46)',
  '--viz-grid': '#2b303b',
  '--viz-baseline': '#3d4453',
  '--viz-series-1': '#f97316',
  '--viz-series-1-hot': '#fb923c',
  // new tokens, each at what its readers painted at 81435a1
  '--placeholder': '#a9a9a9', // WebKit's darkGray (Safari, the iOS app); Chromium's #757575 and Firefox's text at 54% change to it
  '--accent-ink': '#f97316', // color: var(--accent) on text and icons; MEAL_COLORS.cooked
  '--focus-ring': '#f97316', // outline: 2px solid var(--accent)
  '--on-armed-hover': '#ffffff', // .btn.armed's #fff, which a hovered armed button kept
  '--tone-violet': '#c4b5fd', // STATUS_META.wishlist, GITHUB_STATE_META closed / merged
  '--tone-violet-bg': 'rgba(139, 92, 246, 0.2)',
  '--tone-amber': '#fcd34d', // STATUS_META.todo, .due-today, .cal-work-badge.holiday
  '--tone-amber-bg': 'rgba(245, 158, 11, 0.18)',
  '--tone-sky': '#7dd3fc', // STATUS_META.doing, .due-soon, TrendBadge
  '--tone-sky-bg': 'rgba(14, 165, 233, 0.2)',
  '--tone-sky-bg-strong': 'rgba(14, 165, 233, 0.25)', // .swipe-action
  '--tone-rose': '#fda4af', // STATUS_META.blocked, .due-overdue
  '--tone-rose-bg': 'rgba(244, 63, 94, 0.2)',
  '--tone-rose-border': 'rgba(244, 63, 94, 0.45)', // .chart-card.warn-card
  '--tone-green': '#86efac', // STATUS_META.done, GITHUB_STATE_META.open
  '--tone-green-bg': 'rgba(34, 197, 94, 0.18)',
  '--tone-grey': '#9ca3af', // STATUS_META.canceled, PRIORITY_META.low
  '--tone-grey-bg': 'rgba(148, 163, 184, 0.16)',
  '--tone-orange': '#fdba74', // .due-late, .cal-work-badge.off
  '--tone-orange-bg': 'rgba(251, 146, 60, 0.2)',
  '--tone-indigo': '#a5b4fc', // .swipe-action.next
  '--tone-indigo-bg': 'rgba(99, 102, 241, 0.28)',
  '--tone-mint': '#34d399', // .cal-work-badge.home
  '--tone-blue': '#60a5fa', // .cal-work-badge.office
  '--prio-normal': '#b3b8c4', // PRIORITY_META.normal
  '--prio-high': '#fb923c', // PRIORITY_META.high, .card.prio-border-high
  '--cal-meal-out': '#38bdf8', // MEAL_COLORS.out
  '--cal-meal-bought': '#fda4af', // .kitchen-way-bought's var(--tone-rose); a bought meal on the Calendar was MEAL_OUT_COLOR's #38bdf8
  '--cal-event-local': '#a78bfa', // LOCAL_EVENT_COLOR
  '--dot-fallback': '#94a3b8', // an event whose calendar is gone
  '--dot-ring': 'transparent', // new, and invisible in dark
  '--launch-bg': '#0f1115', // .lock-overlay
  '--code-bg': '#0b0d11', // .md pre
  '--tile-top': 'var(--surface-2)', // .stat-tile's gradient top
  '--shadow-overlay': '0 20px 50px rgba(0, 0, 0, 0.6)', // .modal, .cal-sheet
  '--shadow-palette': '0 24px 60px rgba(0, 0, 0, 0.6)', // .search-palette
  '--shadow-pop': '0 8px 24px rgba(0, 0, 0, 0.5)', // .toast, .action-menu-items, .notes-emoji
  '--shadow-menu': '0 10px 30px rgba(0, 0, 0, 0.35)', // .cal-add-menu's rgb(0 0 0 / 0.35)
  '--shadow-sheet': '0 -10px 44px rgba(0, 0, 0, 0.5)', // .native .modal
  '--scrim': 'rgba(0, 0, 0, 0.6)', // .modal-backdrop, .cal-sheet-backdrop
  '--scrim-sheet': 'rgba(0, 0, 0, 0.5)', // .native .modal-backdrop
  '--scrim-strong': 'rgba(0, 0, 0, 0.65)', // .auth-overlay
  '--tabbar-edge': 'rgba(255, 255, 255, 0.05)', // .native .tabs-compact
  '--viz-empty': '#2a2f3a', // --border, on the chart fills that read it
  '--viz-empty-opacity': '0.35', // the weekly bars' zero weeks, drawn at 0.35; not a colour but themed with them
  '--viz-bar-opacity': '0.85', // .rm-bar's and .weekday-bar's 0.85
  '--review-day-opacity': '0.8', // .review-day's 0.8
  '--viz-mood': 'var(--viz-series-1)', // .mood-col's fill
  '--viz-mood-floor': '0.35', // the mood columns' 0.35 + (mood - 1) × 0.65 / 4
  '--viz-ink': '#a9b0be', // --text-2, the mood chart's currentColor
}

/**
 * The dark inks that did not read as they shipped, changed on purpose; nothing
 * else in dark moves. Each is at what it painted at 81435a1 (`was`) and what it
 * is now (`now`, absent for a token gone from dark), beside the pair it failed.
 * Dark placeholders also changed in Chromium and Firefox, which painted their
 * own greys (#757575, and the input's text at 54%) where --placeholder is now
 * WebKit's darkGray everywhere; the token itself is as it was.
 */
const DARK_CHANGED: Record<string, { was: string; now?: string }> = {
  // muted text: 4.17:1 on a card, 3.74 on a raised surface, 3.02 on an accent chip there
  '--muted': { was: '#737b8b', now: '#939bab' },
  // the inverse pill's quiet ink (a chosen chip's count, the toast's ✕), .toast-close's --muted: 3.5:1 on the light pill
  '--inverse-muted': { was: '#737b8b', now: '#596170' },
  // the toast's Undo, .toast-undo's var(--accent): 2.31:1 on the light pill
  '--inverse-accent': { was: '#f97316', now: '#ad3a0b' },
  // an armed delete's label, .btn.armed's #fff: 2.77:1 on the pale red
  '--on-danger': { was: '#ffffff', now: '#0f1115' },
  // a calendar pill's time at 85%: under 4.5:1 for every colour readableInk moves, and some it does not
  '--pill-time-opacity': { was: '0.85' },
  // the mood chart's labels, .mood-chart text's 0.6 of --viz-ink: 3.74:1
  '--viz-label-opacity': { was: '0.6', now: '0.8' },
  // the mood chart's scrub cursor, .mood-cursor's 0.45 of --viz-ink: 2.50:1 on the lit day it is drawn under
  '--viz-cursor-opacity': { was: '0.45', now: '0.6' },
  // its weekly-average line, .mood-avg-line's 0.5: 2.99:1 on the card, and all but gone on a column
  '--viz-avg-opacity': { was: '0.5', now: '0.55' },
}

describe('the two palettes in 01-base.css', () => {
  it('is light by default and dark under data-theme', () => {
    expect(light['color-scheme']).toBe('light')
    expect(dark['color-scheme']).toBe('dark')
  })

  it('declares every dark token on the bare :root too, so nothing is dark-only', () => {
    expect(props(dark).filter(p => !(p in light))).toEqual([])
  })

  it('keeps the non-colour tokens and the fixed colours out of the dark block, and every other colour in it', () => {
    for (const p of [...NON_COLOUR, ...Object.keys(FIXED)]) expect(dark, p).not.toHaveProperty(p)
    for (const p of NON_COLOUR) expect(light, p).toHaveProperty(p)
    const themed = props(light).filter(p => !NON_COLOUR.includes(p) && !(p in FIXED))
    expect(themed.filter(p => !(p in dark))).toEqual([])
  })

  it('paints dark exactly as it was, but for the few inks changed on purpose', () => {
    const changed = Object.fromEntries(Object.entries(DARK_CHANGED).flatMap(([p, c]) => (c.now === undefined ? [] : [[p, c.now]])))
    expect(dark).toEqual({ ...DARK, ...changed })
    for (const [p, c] of Object.entries(DARK_CHANGED)) {
      expect(DARK, p).not.toHaveProperty(p)
      expect(c.now, p).not.toBe(c.was)
    }
    for (const [p, v] of Object.entries(FIXED)) expect(light[p], p).toBe(v)
  })

  it('is the only place a colour token is declared', () => {
    const colourTokens = props(light).filter(p => !NON_COLOUR.includes(p))
    for (const file of sheetImports().filter(f => f !== '01-base.css')) {
      const declared = [...strip(read(file)).matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1])
      expect(
        declared.filter(p => colourTokens.includes(p)),
        file,
      ).toEqual([])
    }
  })
})

type Rgba = [number, number, number, number]

type Palette = Record<string, string>
/** A token's value in `palette`; dark falls back to :root for the fixed colours, declared once. */
const valueIn = (palette: Palette, token: string) => palette[token] ?? light[token]

/** A value as a colour: a hex, an rgba(), a var() read in `palette`, or one of those color-mix()ed with transparent. */
function colour(value: string, palette: Palette = light): Rgba {
  const ref = /^var\((--[\w-]+)\)$/.exec(value)
  if (ref) return colour(valueIn(palette, ref[1]), palette)
  const hex = parseHex(value)
  if (hex) return [...hex, 1]
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value)
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])]
  const mix = /^color-mix\(in srgb, (.+) ([\d.]+)%, transparent\)$/.exec(value)
  if (mix) {
    const [r, g, b, a] = colour(mix[1], palette)
    return [r, g, b, (a * Number(mix[2])) / 100]
  }
  throw new Error(`not a colour: ${value}`)
}
const hexOf = ([r, g, b]: Rgba) => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
/** What a token paints on a solid ground, in light unless `palette` says otherwise. */
const over = (token: string, ground: string, palette: Palette = light) => {
  const c = colour(valueIn(palette, token), palette)
  return mixHex(hexOf(c), ground, c[3])
}
/** A token that must be solid, as a hex, in light unless `palette` says otherwise. */
const solid = (token: string, palette: Palette = light) => {
  const c = colour(valueIn(palette, token), palette)
  expect(c[3], token).toBe(1)
  return hexOf(c)
}

describe('the light palette reads (WCAG 2.x)', () => {
  const surface = solid('--surface')
  const surface2 = solid('--surface-2')
  const accent = solid('--accent')
  const grounds: Record<string, string> = { '--bg': solid('--bg'), '--surface': surface, '--surface-2': surface2 }
  // the accent washes that text sits on: row hovers, chips on --accent-soft, the 20% tint, code
  const washes: Record<string, string> = {
    'accent 4% on --surface': mixHex(accent, surface, 0.04),
    'accent 6% on --surface-2': mixHex(accent, surface2, 0.06),
    '--accent-soft on --surface': over('--accent-soft', surface),
    '--accent-soft on --surface-2': over('--accent-soft', surface2),
    'accent 20% on --surface': mixHex(accent, surface, 0.2),
    '--code-bg': solid('--code-bg'),
  }

  /** What light `ink` paints on a solid `ground` at the light opacity token `opacity`. */
  const at = (ink: string, opacity: string, ground: string) => mixHex(solid(ink), ground, Number(light[opacity]))

  /** Every pair under `min`, as "ink on ground: ratio", so a failure names them all. */
  const under = (min: number, inks: string[], on: Record<string, string>) =>
    inks.flatMap(ink =>
      Object.entries(on)
        .map(([name, ground]) => [name, contrast(solid(ink), ground)] as const)
        .filter(([, ratio]) => ratio < min)
        .map(([name, ratio]) => `${ink} on ${name}: ${ratio.toFixed(2)}`),
    )

  it('gives every text colour 4.5:1 on the page, a card and a raised surface', () => {
    const text = ['--text', '--text-2', '--muted', '--placeholder', '--accent-text', '--accent-ink', '--danger', '--ok', '--warn-text']
    const drawn = ['--prio-normal', '--prio-high', '--cal-meal-out', '--cal-meal-bought', '--cal-event-local', '--dot-fallback', '--tone-mint', '--tone-blue', '--tone-orange', '--tone-amber']
    expect(under(4.5, [...text, ...drawn], grounds)).toEqual([])
  })

  it('keeps 4.5:1 for the text that also sits on an accent wash', () => {
    const inks = ['--text', '--text-2', '--muted', '--accent-text', '--accent-ink', '--danger', '--prio-normal', '--prio-high']
    expect(under(4.5, inks, washes)).toEqual([])
    expect(contrast(solid('--text'), over('--mark-bg', surface))).toBeGreaterThanOrEqual(4.5)
  })

  it('gives every tone 4.5:1 on its own tint, over each ground', () => {
    const tints = (bg: string) => Object.fromEntries(Object.entries(grounds).map(([name, g]) => [`${bg} over ${name}`, over(bg, g)]))
    const low: string[] = []
    for (const hue of ['violet', 'amber', 'sky', 'rose', 'green', 'grey', 'orange', 'indigo']) {
      low.push(...under(4.5, [`--tone-${hue}`], tints(`--tone-${hue}-bg`)))
    }
    low.push(...under(4.5, ['--tone-sky'], tints('--tone-sky-bg-strong')))
    low.push(...under(4.5, ['--warn-text'], tints('--warn-bg')))
    expect(low).toEqual([])
  })

  it('reads on the inverse pill and on the accent and danger fills', () => {
    const inverse = solid('--inverse-bg')
    for (const ink of ['--inverse-text', '--inverse-muted', '--inverse-accent']) expect(contrast(solid(ink), inverse), ink).toBeGreaterThanOrEqual(4.5)
    for (const fill of ['--accent', '--accent-hover']) expect(contrast(solid('--on-accent'), solid(fill)), fill).toBeGreaterThanOrEqual(4.5)
    expect(contrast(solid('--on-danger'), solid('--danger'))).toBeGreaterThanOrEqual(4.5)
    // an armed delete, hovered: its label on the danger button's wash and on a subtle button's
    for (const ground of [mixHex(solid('--danger'), surface, 0.08), surface2]) expect(contrast(solid('--on-armed-hover'), ground)).toBeGreaterThanOrEqual(4.5)
  })

  it('never dims a calendar pill’s time, in either theme: readableInk moves its ink only as far as 4.5:1', () => {
    expect(light).not.toHaveProperty('--pill-time-opacity')
    expect(strip(read('03-board-calendar.css'))).not.toMatch(/\.cal-pill-time\s*\{[^}]*opacity/)
  })

  it('gives focus rings and chart series 3:1, at the strength each mark is drawn', () => {
    expect(under(3, ['--focus-ring'], { ...grounds, '--surface-3': solid('--surface-3') })).toEqual([])
    expect(under(3, ['--viz-series-1', '--viz-series-1-hot', '--viz-mood'], grounds)).toEqual([])
    // marks drawn at an opacity: the Timeline span and the weekday mood bars,
    // Review's done-per-day bars, and the faintest (mood 1) mood column
    const drawn = [
      ['--viz-series-1', '--viz-bar-opacity'],
      ['--viz-series-1', '--review-day-opacity'],
      ['--viz-mood', '--viz-mood-floor'],
    ]
    const faint = drawn.flatMap(([ink, opacity]) =>
      Object.entries(grounds)
        .map(([name, ground]) => [name, contrast(at(ink, opacity, ground), ground)] as const)
        .filter(([, ratio]) => ratio < 3)
        .map(([name, ratio]) => `${ink} at ${opacity} on ${name}: ${ratio.toFixed(2)}`),
    )
    expect(faint).toEqual([])
  })

  it('draws an empty mark quiet but still visible on every ground, the open row’s --surface-2 included', () => {
    for (const [name, ground] of Object.entries(grounds)) {
      const ratio = contrast(at('--viz-empty', '--viz-empty-opacity', ground), ground)
      expect(ratio, name).toBeGreaterThanOrEqual(1.4)
      expect(ratio, name).toBeLessThan(3)
    }
  })
})

describe('a meal’s colour, on the Calendar and in Kitchen → Stats alike (WCAG 2.x)', () => {
  /** Cooked, eaten out at a saved place, and bought: MEAL_COLORS in Calendar.tsx. */
  const WAYS = ['--accent-ink', '--cal-meal-out', '--cal-meal-bought']
  const THEMES = [
    ['light', light],
    ['dark', dark],
  ] as const

  it('declares eaten out and bought in both palettes', () => {
    for (const token of ['--cal-meal-out', '--cal-meal-bought']) {
      expect(light, token).toHaveProperty(token)
      expect(dark, token).toHaveProperty(token)
    }
    expect(light['--cal-meal-bought']).not.toBe(dark['--cal-meal-bought'])
  })

  it('writes each way 4.5:1 on a meal pill’s raised ground and on a day’s card, in both themes', () => {
    const low = THEMES.flatMap(([name, palette]) =>
      ['--surface', '--surface-2'].flatMap(ground =>
        WAYS.map(ink => [ink, ground, contrast(solid(ink, palette), solid(ground, palette))] as const)
          .filter(([, , ratio]) => ratio < 4.5)
          .map(([ink, g, ratio]) => `${ink} on ${g} in ${name}: ${ratio.toFixed(2)}`),
      ),
    )
    expect(low).toEqual([])
  })
})

describe('the inks changed in dark now read there (WCAG 2.x)', () => {
  const d = (token: string) => solid(token, dark)
  const grounds: Record<string, string> = { '--bg': d('--bg'), '--surface': d('--surface'), '--surface-2': d('--surface-2'), '--surface-3': d('--surface-3') }
  const accent = d('--accent')
  // the same washes the light palette is held to
  const washes: Record<string, string> = {
    'accent 4% on --surface': mixHex(accent, grounds['--surface'], 0.04),
    'accent 6% on --surface-2': mixHex(accent, grounds['--surface-2'], 0.06),
    '--accent-soft on --surface': over('--accent-soft', grounds['--surface'], dark),
    '--accent-soft on --surface-2': over('--accent-soft', grounds['--surface-2'], dark),
    'accent 20% on --surface': mixHex(accent, grounds['--surface'], 0.2),
    '--code-bg': d('--code-bg'),
  }

  it('gives muted text 4.5:1 on every ground and accent wash', () => {
    const low = Object.entries({ ...grounds, ...washes })
      .map(([name, ground]) => [name, contrast(d('--muted'), ground)] as const)
      .filter(([, ratio]) => ratio < 4.5)
      .map(([name, ratio]) => `--muted on ${name}: ${ratio.toFixed(2)}`)
    expect(low).toEqual([])
  })

  it('reads on the light pill dark draws for a chosen chip and the toast', () => {
    for (const ink of ['--inverse-text', '--inverse-muted', '--inverse-accent']) expect(contrast(d(ink), d('--inverse-bg')), ink).toBeGreaterThanOrEqual(4.5)
  })

  it('gives an armed delete’s label 4.5:1 on the red, and on either hover wash', () => {
    expect(contrast(d('--on-danger'), d('--danger'))).toBeGreaterThanOrEqual(4.5)
    for (const ground of [mixHex(d('--danger'), grounds['--surface'], 0.08), grounds['--surface-2']]) expect(contrast(d('--on-armed-hover'), ground)).toBeGreaterThanOrEqual(4.5)
  })

  it('gives the mood chart’s labels 4.5:1 on the card, in both themes', () => {
    for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
      const card = solid('--surface', palette)
      const label = mixHex(solid('--viz-ink', palette), card, Number(valueIn(palette, '--viz-label-opacity')))
      expect(contrast(label, card), name).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('gives the mood chart’s scrub cursor and weekly-average line 3:1 on their own grounds, in both themes', () => {
    const journal = strip(read('15-journal.css'))
    // the scrubbed day's lit rect is drawn after the cursor, so it lies over the line and its ground alike
    const lit = Number(/\.mood-day\.on \.mood-hit\s*\{[^}]*fill-opacity:\s*([\d.]+)/.exec(journal)?.[1])
    expect(lit).toBeGreaterThan(0)
    expect(journal).toMatch(/\.mood-cursor\s*\{[^}]*opacity:\s*var\(--viz-cursor-opacity\)/)
    expect(journal).toMatch(/\.mood-avg-line\s*\{[^}]*opacity:\s*var\(--viz-avg-opacity\)/)
    // the line runs on a casing of the card's own colour, so it never sits straight on a column
    expect(journal).toMatch(/\.mood-avg-casing\s*\{[^}]*stroke:\s*var\(--surface\)/)
    for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
      const card = solid('--surface', palette)
      const ink = solid('--viz-ink', palette)
      const cursor = mixHex(ink, mixHex(ink, card, Number(valueIn(palette, '--viz-cursor-opacity'))), lit)
      expect(contrast(cursor, mixHex(ink, card, lit)), `${name} cursor`).toBeGreaterThanOrEqual(3)
      const line = mixHex(ink, card, Number(valueIn(palette, '--viz-avg-opacity')))
      expect(contrast(line, card), `${name} average line`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('the copies other code keeps of the palette', () => {
  it('THEME_HEX is the sheet’s surface, raised surface, ink ground and text in each theme', () => {
    expect(THEME_HEX.light).toEqual({ surface: light['--surface'], raised: light['--surface-2'], inkGround: light['--surface-2'], text: light['--text'] })
    expect(THEME_HEX.dark).toEqual({ surface: dark['--surface'], raised: dark['--surface-2'], inkGround: dark['--surface'], text: dark['--text'] })
  })

  it('THEME_GROUND is the light page ground and each theme’s launch ground', () => {
    expect(THEME_GROUND.light).toBe(light['--bg'])
    expect(THEME_GROUND.light).toBe(light['--launch-bg'])
    expect(THEME_GROUND.dark).toBe(dark['--launch-bg'])
  })

  it('the contrast helpers’ inks are the user-colour ink tokens', () => {
    expect(ON_USER).toBe(light['--on-user-color'])
    expect(ON_DEEP_USER).toBe(light['--on-deep-user-color'])
  })
})

type Paint = { color: string; bg?: string }

/**
 * The badge tables as they painted until 2026-09-14 (priority is a glyph, so a
 * colour alone). Each entry now names a token, and in dark that token is
 * exactly the colour the table held.
 */
const WAS: Record<string, Record<string, Paint>> = {
  STATUS_META: {
    wishlist: { color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.2)' },
    todo: { color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
    doing: { color: '#7dd3fc', bg: 'rgba(14, 165, 233, 0.2)' },
    blocked: { color: '#fda4af', bg: 'rgba(244, 63, 94, 0.2)' },
    done: { color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
    canceled: { color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
  },
  PROJECT_STATUS_META: {
    active: { color: '#7dd3fc', bg: 'rgba(14, 165, 233, 0.2)' },
    paused: { color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
    done: { color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
    archived: { color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
  },
  SEEN_META: {
    never: { color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
    overdue: { color: '#fda4af', bg: 'rgba(244, 63, 94, 0.2)' },
    due: { color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
    ok: { color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
  },
  GITHUB_STATE_META: {
    open: { color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
    closed: { color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.2)' },
    merged: { color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.2)' },
    draft: { color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
  },
  PRIORITY_META: {
    low: { color: '#9ca3af' },
    normal: { color: '#b3b8c4' },
    high: { color: '#fb923c' },
    urgent: { color: '#f87171' },
  },
}

describe('the badge tables hold theme tokens', () => {
  const tables: Record<string, Record<string, Paint>> = { STATUS_META, PROJECT_STATUS_META, SEEN_META, GITHUB_STATE_META, PRIORITY_META }
  /** The token a value names, when it is exactly one var(). */
  const tokenOf = (value: string) => /^var\((--[\w-]+)\)$/.exec(value)?.[1]
  /** Each entry's colour, and its tint where it has one, as [what, value]. */
  const paints = (table: Record<string, Paint>) =>
    Object.entries(table).flatMap(([key, { color, bg }]) => [[`${key}.color`, color] as const, ...(bg === undefined ? [] : [[`${key}.bg`, bg] as const])])

  it('names a token the light palette defines for every colour and tint', () => {
    const loose = Object.entries(tables).flatMap(([name, table]) =>
      paints(table)
        .filter(([, value]) => {
          const token = tokenOf(value)
          return !token || !(token in light)
        })
        .map(([what, value]) => `${name}.${what} = ${value}`),
    )
    expect(loose).toEqual([])
  })

  it('paints dark exactly as the literals did', () => {
    const inDark = (value: string) => dark[tokenOf(value)!] ?? light[tokenOf(value)!]
    const now = Object.fromEntries(
      Object.entries(tables).map(([name, table]) => [
        name,
        Object.fromEntries(Object.entries(table).map(([key, { color, bg }]) => [key, bg === undefined ? { color: inDark(color) } : { color: inDark(color), bg: inDark(bg) }])),
      ]),
    )
    expect(now).toEqual(WAS)
  })
})
