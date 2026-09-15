import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * Every colour the app paints is a theme token. src/styles/01-base.css holds
 * the light palette on :root and the dark one on :root[data-theme='dark'], and
 * nothing else writes a colour out: a literal anywhere else paints the same in
 * both themes, so one of them goes unreadable (a pastel tuned for dark on
 * white, or white on white). This holds that for this build and for every
 * branch that merges after it.
 *
 * What stays a literal is data, not paint: the user's own colours
 * (PROJECT_COLORS, the templates', a synced row's default), and the two modules
 * that mirror the palette for the contrast maths (theme.ts, contrast.ts), which
 * theme-tokens.test.ts holds equal to the sheet. A mask-image is exempt too: it
 * reads only alpha.
 */

const HINT = 'use a theme token (see src/styles/01-base.css)'
const path = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const read = (rel: string) => readFileSync(path(rel), 'utf8')

/** A hex colour (not an HTML entity such as &#8230;), or an rgb(a)() / hsl(a)() call. */
const LITERAL = /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/gi
/** The named colours a hand reaches for. transparent and currentColor are not colours of their own. */
const NAMED = 'white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|brown'
const NAMED_VALUE = new RegExp(`(?<![\\w-])(?:${NAMED})(?![\\w-])`, 'i')
/** A named colour in a style object or an SVG attribute: { color: 'white' }, fill="black". */
const NAMED_IN_TS = new RegExp(`\\b(?:color|background(?:Color)?|border(?:Top|Right|Bottom|Left)?Color|outlineColor|caretColor|fill|stroke|stopColor)\\s*[:=]\\s*\\{?\\s*['"\`](?:${NAMED})['"\`]`, 'gi')

/** `text` with every match of `re` blanked out, newlines kept, so a hit still reports its own line. */
const blank = (text: string, re: RegExp) => text.replace(re, m => m.replace(/[^\n]/g, ' '))
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

/** "file:line: the line as written" for each index in `at`. */
const report = (file: string, source: string, at: number[]) => {
  const lines = source.split('\n')
  return at.map(i => {
    const n = lineOf(source, i)
    return `${file}:${n}: ${lines[n - 1].trim()}`
  })
}

/** The colours a stylesheet writes out, outside comments, the two palettes and mask images. */
function cssLiterals(file: string, source: string): string[] {
  let css = blank(source, /\/\*[\s\S]*?\*\//g)
  if (file === '01-base.css') css = blank(css, /^:root(?:\[data-theme='dark'\])?\s*\{[^{}]*\}/gm)
  css = blank(css, /(?:-webkit-)?mask(?:-image)?\s*:[^;{}]*/g)
  const at = [...css.matchAll(LITERAL)].map(m => m.index!)
  // a named colour, looked for in declaration values only (a selector can say .red-dot)
  for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
    for (const decl of block[1].matchAll(/([-\w]+)\s*:([^;]*)/g)) {
      const value = decl[2].replace(/(["']).*?\1/g, '').replace(/--[\w-]+/g, '')
      if (NAMED_VALUE.test(value)) at.push(block.index! + 1 + decl.index!)
    }
  }
  return report(file, source, at.sort((a, b) => a - b))
}

/**
 * The rules a stylesheet gives a focused element that draw in the plain
 * accent. The house orange is under 3:1 on white, so a focus cue drawn in it
 * goes unseen in light; --focus-ring is the accent tuned to read in each theme.
 */
function focusInAccent(file: string, source: string): string[] {
  const css = blank(source, /\/\*[\s\S]*?\*\//g)
  const at = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /:focus/.test(m[1]) && /var\(--accent\)/.test(m[2])).map(m => m.index! + m[0].indexOf('{'))
  return report(file, source, at)
}

/** Whole modules that hold data colours or the palette's mirrors. */
const EXEMPT_FILES = ['templates.ts', 'syncengine.ts', 'sync.ts', 'theme.ts', 'contrast.ts']
/** Declarations inside an otherwise guarded module that hold data colours. */
const EXEMPT_DECLARATIONS: Record<string, RegExp[]> = {
  'types.ts': [/^export const PROJECT_COLORS\b.*$/m],
  // a photo's own colour, worked out from its pixels for a name suggestion: image data, not a UI colour
  'photo.ts': [/^export function averageHex\b[\s\S]*?^\}$/m],
}

/** The colours a module writes out, outside comments and its exempt declarations. */
function tsLiterals(file: string, source: string): string[] {
  // a comment opens at a line start, after space or after {; `image/*` and https:// are not comments
  let ts = blank(source, /(?<=^|[\s{])\/\*[\s\S]*?\*\/|(?<=^|[\s{])\/\/.*$/gm)
  for (const re of EXEMPT_DECLARATIONS[file] ?? []) ts = blank(ts, re)
  const at = [...ts.matchAll(LITERAL), ...ts.matchAll(NAMED_IN_TS)].map(m => m.index!)
  return report(file, source, at.sort((a, b) => a - b))
}

/** Every .ts/.tsx under src, tests and the stylesheet folder aside, relative to src. */
function modules(dir = ''): string[] {
  return readdirSync(path(dir || '.'), { withFileTypes: true }).flatMap(e => {
    const rel = dir ? `${dir}/${e.name}` : e.name
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'styles' ? [] : modules(rel)
    return /\.tsx?$/.test(e.name) ? [rel] : []
  })
}

describe('colour lives in the theme tokens', () => {
  it('sees a colour written any of the usual ways, and not what only looks like one', () => {
    const css = '.a { color: #fff; }\n.b { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); }\n.c { background: hsl(20 90% 50%); }\n.d { color: white; }\n.red-dot:not(.black) { color: var(--tone-green); white-space: nowrap; }'
    expect(cssLiterals('x.css', css).map(h => h.split(':')[1])).toEqual(['1', '2', '3', '4'])
    const ts = "const a = { color: '#abc' }\nconst b = `0 0 0 1px rgba(0,0,0,.1)`\n<path fill=\"black\" />\nconst c = 'Issue #12 &#8230;' // #fff in a comment\nconst d = <input accept=\"image/*\" style={{ color: 'var(--text)' }} />"
    expect(tsLiterals('x.tsx', ts).map(h => h.split(':')[1])).toEqual(['1', '2', '3'])
  })

  it('writes no colour in the stylesheet outside the two palettes in 01-base.css', () => {
    const sheets = readdirSync(path('styles')).filter(f => f.endsWith('.css'))
    expect(sheets).toContain('01-base.css')
    expect(sheets.flatMap(f => cssLiterals(f, read(`styles/${f}`))), HINT).toEqual([])
  })

  it('draws every focus cue in --focus-ring, never the plain accent', () => {
    const sample = '.a:focus {\n  border-color: var(--accent);\n}\n.b:focus-visible { outline-color: var(--accent-ink); }\n.c:hover { color: var(--accent); }\n@media (x) {\n  .d:focus-within { box-shadow: 0 0 0 2px var(--accent); }\n}'
    expect(focusInAccent('x.css', sample).map(h => h.split(':')[1])).toEqual(['1', '7'])
    const sheets = readdirSync(path('styles')).filter(f => f.endsWith('.css'))
    expect(
      sheets.flatMap(f => focusInAccent(f, read(`styles/${f}`))),
      'a focus indicator reads var(--focus-ring)',
    ).toEqual([])
  })

  it('writes no colour in a component or module outside the data files', () => {
    const files = modules().filter(f => !EXEMPT_FILES.includes(f))
    expect(files).toContain('components/Calendar.tsx')
    expect(files.flatMap(f => tsLiterals(f, read(f))), HINT).toEqual([])
  })

  it('still finds everything it exempts, so the list cannot outlive what it names', () => {
    for (const f of EXEMPT_FILES) expect(() => read(f), f).not.toThrow()
    for (const [f, res] of Object.entries(EXEMPT_DECLARATIONS)) for (const re of res) expect(read(f), `${f} ${re}`).toMatch(re)
  })
})
