import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * Some tests read source text instead of rendering it (vitest runs in node).
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

/** The whole sheet as one text: each partial index.css imports, in order, joined with nothing. */
export function sheetSource(): string {
  return sheetImports()
    .map(f => read(`styles/${f}`))
    .join('')
}
