import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { trashedLine } from '../itemops'

/*
 * The words the app uses for the same thing, one set of them. A two-step
 * button said "Click again to delete", "Sure? Click again", "Remove?",
 * "Forever? Click again" and a dozen more, on a phone with nothing to click;
 * moving something to the Trash was "Deleted …", "Removed", "… removed" and
 * "… moved to Trash". A source-level ratchet, like a11y.test.ts: a new button
 * or toast has to take the words the rest already use.
 */

const SRC = fileURLToPath(new URL('../', import.meta.url))

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourcesUnder(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

const files = sourcesUnder(join(SRC, 'components')).map(path => ({ path: relative(SRC, path).split(sep).join('/'), src: readFileSync(path, 'utf8') }))

describe('a two-step button', () => {
  it('says "Tap again to …" while it waits for the second tap, wherever it is', () => {
    const labels = files.flatMap(f => [...f.src.matchAll(/confirmLabel=(?:\{([^}]*)\}|"([^"]*)")/g)].map(m => ({ where: f.path, label: m[1] ?? m[2] })))
    expect(labels.length).toBeGreaterThan(20)
    // a label worked out in braces says it in each of its answers
    const odd = labels.filter(({ label }) => [...label.matchAll(/['"`]([^'"`]*)['"`]/g)].map(q => q[1]).concat(label.includes("'") || label.includes('`') ? [] : [label]).some(text => !text.startsWith('Tap again to ')))
    expect(odd).toEqual([])
  })

  it('never says Click, and the default says Tap again to delete', () => {
    expect(files.filter(f => /\bclick again\b/i.test(f.src)).map(f => f.path)).toEqual([])
    expect(files.find(f => f.path === 'components/ConfirmButton.tsx')?.src).toContain("confirmLabel = 'Tap again to delete'")
  })
})

describe('moving something to the Trash', () => {
  it('says so one way, by name where the record has one', () => {
    expect(trashedLine('Fix the gate', 'Task')).toBe('“Fix the gate” moved to Trash')
    expect(trashedLine('  ', 'Task')).toBe('Task moved to Trash')
    expect(trashedLine(null, 'Journal entry')).toBe('Journal entry moved to Trash')
  })

  it('is never worded by hand as Deleted or Removed beside its Undo', () => {
    // "Deleted …", "Removed", "… removed", "… deleted", or the Trash's words typed out again
    const handWorded = files.filter(f => /showToast\((?:[`'](?:Deleted|Removed)\b|'[^']*\b(?:removed|deleted)'|`[^`]*\b(?:removed|deleted)`|`[^`]*moved to Trash`)/.test(f.src)).map(f => f.path)
    expect(handWorded).toEqual([])
  })
})

describe('an archived bill or payday', () => {
  it('is brought back with Unarchive, as an account is, never Restore', () => {
    const actions = files.find(f => f.path === 'components/finance/SheetActions.tsx')?.src ?? ''
    expect(actions).toContain("archived ? 'Unarchive' : 'Archive'")
    expect(files.find(f => f.path === 'components/planner/TasksScreen.tsx')?.src).toContain("archive ? 'Archived' : 'Unarchived'")
  })
})
