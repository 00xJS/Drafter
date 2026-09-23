import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * Some tests read source text instead of rendering it: most tests run in node,
 * with no document. A behaviour that needs one — a click, an effect, a touch —
 * belongs in a *.dom.test.tsx instead (dom.ts), which can run it; what is left
 * here is wiring between files and the style sheet, which no document shows.
 * These helpers are the one place that knows which files that text lives in,
 * so splitting Planner.tsx or the style sheet still feeds every such test the
 * same text.
 */

const path = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const read = (rel: string) => readFileSync(path(rel), 'utf8')

/** Planner.tsx, then every components/planner/*.{ts,tsx} in name order, joined by newlines. */
export function plannerSource(): string {
  const dir = 'components/planner'
  const parts = existsSync(path(dir)) ? readdirSync(path(dir)).filter(f => /\.tsx?$/.test(f)).sort() : []
  return [read('components/Planner.tsx'), ...parts.map(f => read(`${dir}/${f}`))].join('\n')
}

/** The partials styles/index.css imports, in import order. */
export function sheetImports(): string[] {
  return [...read('styles/index.css').matchAll(/^@import '\.\/([^']+\.css)';$/gm)].map(m => m[1])
}

/**
 * The lazy views' own sheets, styles/views/*.css, in name order: the rules only
 * one lazy view can match, loaded with its chunk (components/planner/lazy.ts)
 * and so after every partial — which is how the cascade has them.
 */
export function viewSheets(): string[] {
  return existsSync(path('styles/views')) ? readdirSync(path('styles/views')).filter(f => f.endsWith('.css')).sort().map(f => `views/${f}`) : []
}

/**
 * A partial as it was written: its own text, then every section of a view's
 * sheet that came from it (each is headed "from <partial>"). A rule only one
 * lazy view matches loads with that view now, but it is still the partial's
 * rule, and a test about the partial's rules reads them all here.
 */
export function partialSource(name: string): string {
  const own = read(`styles/${name}`)
  const moved = viewSheets().flatMap(f => read(`styles/${f}`).split(/(?=\/\* -{10} from )/).filter(part => part.startsWith(`/* ---------- from ${name} ----------`)))
  return [own, ...moved].join('\n')
}

/** One view's own sheet, by its file name in styles/views/. */
export function viewSheet(name: string): string {
  return read(`styles/views/${name}`)
}

/** The whole sheet as one text: each partial index.css imports, in order, then the views' sheets, joined with nothing. */
export function sheetSource(): string {
  return [...sheetImports(), ...viewSheets()]
    .map(f => read(`styles/${f}`))
    .join('')
}
