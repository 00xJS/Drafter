import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sheetImports, sheetSource } from './source'

/*
 * The style sheet is styles/index.css plus the partials it imports, in cascade
 * order; Vite inlines them into one sheet. These pin the shape that keeps the
 * split safe to edit — one way in, one order, no block across two files — so
 * the cascade phonecss.test.ts reasons about is the one that ships.
 */

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const read = (rel: string) => readFileSync(path(rel), 'utf8')
const index = read('../styles/index.css')

/** Brace depth at the end of a sheet, skipping comments and strings: 0 when it closes every block it opens. */
function braceDepth(css: string): number {
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end < 0) return NaN // an unclosed comment swallows the rest
      i = end + 1
    } else if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c && css[i] !== '\n'; i++) if (css[i] === '\\') i++
    } else if (c === '{') depth++
    else if (c === '}' && --depth < 0) return -1 // closes a block it never opened
  }
  return depth
}

/** Every .ts/.tsx module under src, tests aside, relative to this folder. */
function modules(dir = '../'): string[] {
  return readdirSync(path(dir), { withFileTypes: true }).flatMap(e => {
    if (e.isDirectory()) return e.name === '__tests__' ? [] : modules(`${dir}${e.name}/`)
    return /\.tsx?$/.test(e.name) ? [`${dir}${e.name}`] : []
  })
}

/** The CSS a module imports — side-effect, from and dynamic imports alike. */
const cssImports = (code: string) => [...code.matchAll(/\bimport\b(?!\.)[^'"`;]*?['"]([^'"\n]+\.css(?:\?[^'"\n]*)?)['"]/g)].map(m => m[1])

describe('the style sheet: one index, partials in order, nothing across two files', () => {
  it('index.css holds nothing but @import lines', () => {
    const lines = index.split('\n').filter(l => l.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter(l => !/^@import '\.\/[\w-]+\.css';$/.test(l))).toEqual([])
    expect(sheetImports()).toHaveLength(lines.length)
  })

  it('imports every partial in styles/ exactly once', () => {
    const imports = sheetImports()
    const partials = readdirSync(path('../styles')).filter(f => f.endsWith('.css') && f !== 'index.css')
    expect(new Set(imports).size).toBe(imports.length)
    expect([...imports].sort()).toEqual([...partials].sort())
  })

  it('balances the braces in each partial, so no rule or @media straddles two files', () => {
    const unbalanced = sheetImports().filter(f => braceDepth(read(`../styles/${f}`)) !== 0)
    expect(unbalanced).toEqual([])
  })

  it('imports the native shell last, so its .native rules refine everything before them', () => {
    const imports = sheetImports()
    expect(imports[imports.length - 1]).toBe('19-native-shell.css')
  })

  it("has one [contenteditable='true'] in the whole sheet: the anti-zoom guard's", () => {
    expect(sheetSource().split("[contenteditable='true']")).toHaveLength(2)
  })

  it('is loaded by main.tsx alone, through styles/index.css', () => {
    expect(cssImports(read('../main.tsx'))).toEqual(['./styles/index.css'])
  })

  it('is imported by no component or other module', () => {
    const importers = modules().filter(f => f !== '../main.tsx' && cssImports(read(f)).length > 0)
    expect(importers).toEqual([])
  })
})
