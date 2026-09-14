import { describe, expect, it } from 'vitest'
import { contrast, heatStyle, inkOn, mixHex, ON_DEEP_USER, ON_USER, parseHex, readableInk } from '../contrast'
import { THEME_HEX, type Theme } from '../theme'
import { PROJECT_COLORS } from '../types'

/*
 * User colours (people, places, projects, habits) are data and the same in both
 * themes; these helpers choose what is drawn on them, and move one drawn as
 * text only as far as it takes to read.
 */

const THEMES: Theme[] = ['light', 'dark']
/** Colours from outside the palette: GitHub's wontfix and duplicate labels, a Google calendar's yellow, black. */
const OUTSIDERS = ['#ffffff', '#cfd3d7', '#fad165', '#000000']
const INK: Record<string, string> = { 'var(--on-user-color)': ON_USER, 'var(--on-deep-user-color)': ON_DEEP_USER }

describe('contrast', () => {
  it('is 21 for black on white, and the same either way round', () => {
    expect(contrast('#000', '#fff')).toBe(21)
    expect(contrast('#15181f', '#ffffff')).toBeCloseTo(contrast('#ffffff', '#15181f'), 10)
    expect(contrast('#777777', '#777777')).toBe(1)
  })

  it('reads #rgb and #rrggbb, and nothing else', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255])
    expect(parseHex('#F97316')).toEqual([249, 115, 22])
    for (const junk of ['', 'fff', '#ffff', '#12345g', 'var(--accent)', 'orange', 'rgb(0, 0, 0)']) expect(parseHex(junk), junk).toBeNull()
  })

  it('mixes by the share of the first colour', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#000000')
    expect(mixHex('#ff0000', '#0000ff', 0.5)).toBe('#800080')
  })
})

describe('inkOn: text drawn on a user colour', () => {
  it('is the dark ink on every palette colour', () => {
    for (const c of PROJECT_COLORS) {
      expect(inkOn(c), c).toBe('var(--on-user-color)')
      expect(contrast(ON_USER, c), c).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('is white on a colour too deep for it, such as the MCP project default', () => {
    expect(inkOn('#4f46e5')).toBe('var(--on-deep-user-color)')
  })
})

describe('readableInk: a user colour drawn as text', () => {
  const ground = (color: string, theme: Theme, tint: boolean) => (tint ? mixHex(color, THEME_HEX[theme].inkGround, 0x22 / 255) : THEME_HEX[theme].inkGround)

  it('leaves every palette colour exactly as it was in dark, plain or tinted', () => {
    for (const c of PROJECT_COLORS) {
      expect(readableInk(c, 'dark'), c).toBe(c)
      expect(readableInk(c, 'dark', { tint: true }), c).toBe(c)
    }
  })

  it('reaches 4.5:1 for the palette and for colours from outside it, in both themes', () => {
    for (const theme of THEMES) {
      for (const c of [...PROJECT_COLORS, ...OUTSIDERS]) {
        for (const tint of [false, true]) {
          const ink = readableInk(c, theme, { tint })
          expect(contrast(ink, ground(c, theme, tint)), `${c} ${theme}${tint ? ' tinted' : ''} → ${ink}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('moves a colour only as far as it needs', () => {
    // black already reads on light; amber needs about half the text colour mixed in
    expect(readableInk('#000000', 'light')).toBe('#000000')
    const amber = readableInk('#fbbf24', 'light')
    expect(amber).not.toBe('#fbbf24')
    expect(amber).not.toBe(THEME_HEX.light.text)
  })

  it('passes a token through: it is already tuned for both themes', () => {
    expect(readableInk('var(--cal-meal-out)', 'light')).toBe('var(--cal-meal-out)')
    expect(readableInk('var(--accent-ink)', 'dark', { tint: true })).toBe('var(--accent-ink)')
  })
})

describe('heatStyle: a year-table cell', () => {
  it('keeps the background the tables have always drawn', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(heatStyle('#34d399', n, 'light').background).toBe(`color-mix(in srgb, #34d399 ${Math.min(90, 25 + n * 20)}%, transparent)`)
    }
  })

  it('reads at 4.5:1 for every palette colour, count and theme', () => {
    for (const theme of THEMES) {
      for (const c of PROJECT_COLORS) {
        for (const n of [1, 2, 3, 4, 5, 6]) {
          const { color } = heatStyle(c, n, theme)
          const cell = mixHex(c, THEME_HEX[theme].surface, Math.min(90, 25 + n * 20) / 100)
          const ink = color ? INK[color] : THEME_HEX[theme].text
          expect(ink, `${c} ×${n} ${theme} → ${color}`).toBeDefined()
          expect(contrast(ink, cell), `${c} ×${n} ${theme}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('leaves a one-visit cell in dark with the text it has always had', () => {
    for (const c of PROJECT_COLORS) expect(heatStyle(c, 1, 'dark').color, c).toBeUndefined()
  })
})
