import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * No system dialogs. The browser's alert(), confirm() and prompt() are, in the
 * iPhone app, system alerts that name the page's address — and under iOS 27
 * they wait behind its Safe Browsing check as well. Every question the app
 * asks is its own: a two-step ConfirmButton ("Tap again to …"), Modal's
 * DiscardPrompt, or a field on the page (the notes pad's link and task rows).
 * A source-level ratchet, like wording.test.ts: nothing under src may call
 * one, by window. or bare.
 */

const SRC = fileURLToPath(new URL('../', import.meta.url))

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourcesUnder(path)
    return /\.(tsx?|mts|js|mjs)$/.test(path) ? [path] : []
  })
}

/** Comments out: they may say what was replaced, and why. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')

/** A call of alert, confirm or prompt: on window, globalThis or self, or bare (not a method of something else, not a name that only ends so). */
const DIALOG = /\b(?:window|globalThis|self)\s*\.\s*(?:alert|confirm|prompt)\b|(?<![.\w$])(?:alert|confirm|prompt)\s*\(/g

const calls = (src: string) => [...code(src).matchAll(DIALOG)].map(m => m[0].replace(/\s+/g, ''))

describe('no system dialogs', () => {
  it('sees a dialog called any of the usual ways, and not what only looks like one', () => {
    const sample = [
      "if (!window.confirm('Sure?')) return",
      "const url = window.prompt('Link')",
      'alert(err)',
      'globalThis.confirm("x")',
      'const ok = confirm (x)',
      'store.confirm(r)',
      'markConfirmed(r)',
      'askPrompt(q)',
      "// window.alert('in a comment')",
      "/* confirm('in a block') */",
      "const s = { prompt: 'x' }",
    ].join('\n')
    expect(calls(sample)).toEqual(['window.confirm', 'window.prompt', 'alert(', 'globalThis.confirm', 'confirm('])
  })

  it('calls none of alert, confirm or prompt anywhere in src', () => {
    const files = sourcesUnder(SRC)
    expect(files.length).toBeGreaterThan(100)
    const found = files.flatMap(path => calls(readFileSync(path, 'utf8')).map(c => `${relative(SRC, path).split(sep).join('/')}: ${c}`))
    expect(found).toEqual([])
  })
})
