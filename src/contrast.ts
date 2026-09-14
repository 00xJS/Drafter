import { THEME_HEX, type Theme } from './theme'

/*
 * Contrast for the colours the stylesheet cannot know: a person's, place's,
 * project's or habit's own colour, a GitHub label, a calendar feed's colour.
 * Those stay the user's in both themes. These helpers choose the ink drawn on
 * one, and move one drawn AS text only as far as it takes to read. WCAG 2.x
 * relative luminance in sRGB, with alpha composited by hand.
 */

/** = --on-user-color: dark ink, which reads on every PROJECT_COLORS entry. */
export const ON_USER = '#0f1115'
/** = --on-deep-user-color: white, for a user colour too deep for ON_USER. */
export const ON_DEEP_USER = '#ffffff'

/** '#rgb' or '#rrggbb' as [r, g, b]; anything else (a var(), a name) is null. */
export function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].replace(/./g, d => d + d) : m[1]
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)]
}

const toHex = (rgb: number[]) => `#${rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 2.x contrast ratio of two hex colours, 1 to 21; 1 when either cannot be read. */
export function contrast(a: string, b: string): number {
  const pa = parseHex(a)
  const pb = parseHex(b)
  if (!pa || !pb) return 1
  const [hi, lo] = [luminance(pa), luminance(pb)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `a` over `b` at share `t` of `a` (0 to 1), in sRGB: what `a` at alpha `t` paints on a `b` ground. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  if (!pa || !pb) return a
  return toHex(pa.map((v, i) => v * t + pb[i] * (1 - t)))
}

const betterInk = (ground: string) => (contrast(ON_DEEP_USER, ground) > contrast(ON_USER, ground) ? 'var(--on-deep-user-color)' : 'var(--on-user-color)')

/** The ink for text on a user colour: --on-user-color, or --on-deep-user-color where white reads better. */
export function inkOn(color: string): string {
  return betterInk(color)
}

/** A ground other than the helper's own: 'raised' is --surface-2 (an open row, a GitHub card, a progress track). */
export type InkGround = 'raised'

/** `color` where it reaches `min` against `ground`, else the smallest mix of `text` into it that does, in steps of 5%. */
function nudge(color: string, ground: string, text: string, min: number): string {
  for (let p = 0; p <= 100; p += 5) {
    const ink = p === 0 ? color : mixHex(text, color, p / 100)
    if (contrast(ink, ground) >= min) return ink
  }
  return text
}

/**
 * A user colour drawn as text, readable (4.5:1) on this theme's ground: the
 * colour itself wherever it already reads, else the smallest mix of the theme's
 * text colour into it that does, in steps of 5%. The ground is the darkest one
 * a calendar pill sits on, or --surface-2 with `ground: 'raised'`. `tint` is a
 * pill whose ground is the colour itself at 34/255 (`color + '22'`) over that
 * ground. A value that is not a hex, such as a var() token already tuned for
 * both themes, comes back as it is.
 */
export function readableInk(color: string, theme: Theme, opts: { tint?: boolean; ground?: InkGround } = {}): string {
  if (!parseHex(color)) return color
  const { inkGround, raised, text } = THEME_HEX[theme]
  const base = opts.ground === 'raised' ? raised : inkGround
  return nudge(color, opts.tint ? mixHex(color, base, 0x22 / 255) : base, text, 4.5)
}

/**
 * A user colour drawn as a mark rather than as text: a chart bar, a timeline
 * span, a milestone's edge, a progress fill. A graphic needs 3:1 against what
 * is around it, so this moves the colour the way readableInk does, to 3:1 on
 * --surface (or --surface-2 with `ground: 'raised'`). Every palette colour
 * already clears that in dark, where it comes back exactly as it was.
 */
export function graphicInk(color: string, theme: Theme, opts: { ground?: InkGround } = {}): string {
  if (!parseHex(color)) return color
  const { surface, raised, text } = THEME_HEX[theme]
  return nudge(color, opts.ground === 'raised' ? raised : surface, text, 3)
}

/**
 * A year-table cell: the colour at a strength that grows with the count (the
 * formula the tables have always used). The inherited --text stays wherever it
 * reads on the cell; otherwise the cell takes --on-user-color or
 * --on-deep-user-color, whichever reads better.
 */
export function heatStyle(color: string, n: number, theme: Theme): { background: string; color?: string } {
  const strength = Math.min(90, 25 + n * 20)
  const background = `color-mix(in srgb, ${color} ${strength}%, transparent)`
  if (!parseHex(color)) return { background }
  const { surface, text } = THEME_HEX[theme]
  const cell = mixHex(color, surface, strength / 100)
  return contrast(text, cell) >= 4.5 ? { background } : { background, color: betterInk(cell) }
}
