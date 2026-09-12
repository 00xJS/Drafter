import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/*
 * Planner.tsx was 1,700 lines holding every tab, editor, toast and link. It is
 * now the shell that calls the planner/ hooks and lays out the page; what it
 * rendered inline lives in components/planner/. This keeps it that way.
 */
describe('the shell stays a shell', () => {
  it('keeps Planner.tsx under 300 lines', () => {
    expect(read('../components/Planner.tsx').split('\n').length).toBeLessThan(300)
  })
})
