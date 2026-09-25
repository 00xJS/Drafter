import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sheetImports, sheetSource, viewSheets } from './source'

/*
 * The style sheet is styles/index.css plus the partials it imports, in cascade
 * order; Vite inlines them into one sheet, which loads before the first paint.
 * The rules only one lazy view can match are in that view's own sheet
 * (styles/views/), which loads with the view's chunk and so comes after every
 * partial. These pin the shape that keeps the split safe to edit — one way
 * in for each, one order, no block across two files, and no rule in a view's
 * sheet that anything the launch draws could need — so the cascade
 * phonecss.test.ts reasons about is the one that ships.
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

  it("has [contenteditable='true'] only in the anti-zoom guard: its app arm, then its touch-screen arm", () => {
    // phonecss.test.ts finds the guard by the last one in the sheet
    const holders = sheetImports().filter(f => read(`../styles/${f}`).includes("[contenteditable='true']"))
    expect(holders).toEqual(['16-zoom-guard.css'])
    expect(sheetSource().split("[contenteditable='true']")).toHaveLength(3)
  })

  it('is loaded by main.tsx alone, through styles/index.css', () => {
    expect(cssImports(read('../main.tsx'))).toEqual(['./styles/index.css'])
  })

  it('is imported by no component or other module, the views\u2019 own sheets aside', () => {
    const importers = modules().filter(f => f !== '../main.tsx' && cssImports(read(f)).some(css => !css.includes('/styles/views/')))
    expect(importers).toEqual([])
  })
})

/** The modules a launch loads: main.tsx and the Planner chunk, and whatever they import statically. */
function launchModules(): Set<string> {
  const seen = new Set<string>()
  const todo = [path('../main.tsx'), path('../components/Planner.tsx')]
  while (todo.length) {
    const file = todo.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const m of readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const base = resolve(dirname(file), m[1])
      const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(p => existsSync(p) && statSync(p).isFile())
      if (hit && /\.tsx?$/.test(hit)) todo.push(hit)
    }
  }
  return seen
}

/** The classes a selector list names. */
const classesOf = (selector: string) => [...selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1])

describe('each lazy view\u2019s own sheet', () => {
  // planner/lazy.ts, and the four areas' Stats in their own registry (lazystats.ts)
  const REGISTRIES = ['../components/planner/lazy.ts', '../components/planner/lazystats.ts']
  const lazy = REGISTRIES.map(read).join('\n')

  it('is loaded by planner/lazy.ts or the Stats registry, once, with the view it is for', () => {
    const sheets = viewSheets()
    expect(sheets.length).toBeGreaterThan(0)
    for (const sheet of sheets) {
      const loads = [...lazy.matchAll(new RegExp(`withSheet\\(import\\('[^']+'\\), import\\('\\.\\./\\.\\./styles/${sheet.replace(/[.]/g, '\\.')}'\\)\\)`, 'g'))]
      expect(loads, sheet).toHaveLength(1)
    }
    // …and nothing else imports one
    const importers = modules().filter(f => cssImports(read(f)).some(css => css.includes('/styles/views/')))
    expect(importers.sort()).toEqual(REGISTRIES)
    expect(cssImports(lazy).filter(css => css.includes('/styles/views/'))).toHaveLength(sheets.length)
  })

  it('balances its braces', () => {
    expect(viewSheets().filter(f => braceDepth(read(`../styles/${f}`)) !== 0)).toEqual([])
  })

  it('holds only rules the launch cannot need: each selector names a class nothing the launch loads uses', () => {
    // The shell draws before any view's sheet has loaded, and a view's sheet
    // may not load at all: a rule the shell's own elements could match
    // belongs in a partial, or they are drawn without it.
    // what the launch's modules could put in a class attribute: their strings
    // and templates, comments left out (a class is never an identifier)
    const strings = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
    const shell = [...launchModules()]
      .map(f => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .flatMap(code => code.match(strings) ?? [])
      .join('\n')
    const inShell = (c: string) => new RegExp(`(^|[^\\w-])${c}([^\\w-]|$)`).test(shell)
    const wrong: string[] = []
    for (const sheet of viewSheets()) {
      const css = read(`../styles/${sheet}`).replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of css.matchAll(/([^{};]+)\{/g)) {
        const list = m[1].trim()
        if (list.startsWith('@')) continue
        for (const selector of list.split(',')) if (classesOf(selector).every(inShell)) wrong.push(`${sheet}: ${selector.trim()}`)
      }
    }
    expect(wrong).toEqual([])
  })
})
