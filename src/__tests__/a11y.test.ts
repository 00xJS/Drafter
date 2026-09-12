import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * A ratchet on the accessibility pass: the source may not slide back to
 * dialogs drawn by hand or rows only a mouse can open. Source-level on
 * purpose, like the other tests that read components (vitest runs in node).
 */

const SRC = fileURLToPath(new URL('../', import.meta.url))

function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : tsxUnder(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

/** Every component, as `components/Foo.tsx` and its text. */
const files = tsxUnder(SRC).map(path => ({ path: relative(SRC, path).split(sep).join('/'), src: readFileSync(path, 'utf8') }))

/**
 * Dialogs still drawn by hand because another stream is splitting them; each
 * adopts Modal when its split lands, and its entry goes with it.
 */
const NOT_YET_ON_MODAL = [
  'components/TaskEditor.tsx', // TODO(level-up): remove after Modal adoption
  'components/Settings.tsx', // TODO(level-up): remove after Modal adoption
  'components/taskeditor/', // TODO(level-up): remove after Modal adoption
  'components/settings/', // TODO(level-up): remove after Modal adoption
  'components/ConnectAssistantSheet.tsx', // TODO(level-up): remove after Modal adoption
]
const notYetOnModal = (path: string) => NOT_YET_ON_MODAL.some(p => (p.endsWith('/') ? path.startsWith(p) : path === p))

/** Just past the `>` that ends the JSX opening tag starting at `from`; a `>` inside braces or quotes does not count. */
function tagEnd(src: string, from: number): number {
  let depth = 0
  let quote = ''
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = ''
    } else if (c === '"' || c === "'" || (c === '`' && depth > 0)) quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i + 1
  }
  return src.length
}

/** The element whose opening tag starts at `from`, through its matching close. */
function elementAt(src: string, name: string, from: number): string {
  const open = tagEnd(src, from)
  if (src[open - 2] === '/') return src.slice(from, open)
  const tags = new RegExp(`<(/?)${name}(?=[\\s>/])`, 'g')
  tags.lastIndex = open
  let depth = 1
  for (let m = tags.exec(src); m; m = tags.exec(src)) {
    if (m[1]) {
      if (--depth === 0) return src.slice(from, tags.lastIndex)
    } else if (src[tagEnd(src, m.index) - 2] !== '/') depth++
  }
  return src.slice(from)
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

/** Every opening tag named `names` in the components, with where it is and the whole element. */
function elements(names: string) {
  const out: { where: string; tag: string; element: string }[] = []
  for (const f of files) {
    const re = new RegExp(`<(${names})(?=[\\s>])`, 'g')
    for (let m = re.exec(f.src); m; m = re.exec(f.src)) {
      out.push({ where: `${f.path}:${lineOf(f.src, m.index)}`, tag: f.src.slice(m.index, tagEnd(f.src, m.index)), element: elementAt(f.src, m[1], m.index) })
    }
  }
  return out
}

describe('every dialog is a Modal', () => {
  // an attribute, not PullToRefresh's `[role="dialog"]` selector
  const ROLE_DIALOG = /\srole=\{?["'`]dialog["'`]\}?/

  it('writes role="dialog" by hand only in Modal and the lock screen', () => {
    // LockGate is a gate: Escape must never close it, so it is not a Modal
    const owners = ['components/Modal.tsx', 'components/LockGate.tsx']
    expect(files.find(f => f.path === 'components/Modal.tsx')?.src).toMatch(ROLE_DIALOG)
    const offenders = files.filter(f => ROLE_DIALOG.test(f.src) && !owners.includes(f.path) && !notYetOnModal(f.path)).map(f => f.path)
    expect(offenders).toEqual([])
  })

  it('draws no backdrop by hand', () => {
    const BACKDROP = /\bclassName=\{?["'`][^"'`]*\bmodal-backdrop\b/
    expect(files.find(f => f.path === 'components/Modal.tsx')?.src).toMatch(/'modal-backdrop'/)
    const offenders = files.filter(f => BACKDROP.test(f.src) && f.path !== 'components/Modal.tsx' && !notYetOnModal(f.path)).map(f => f.path)
    expect(offenders).toEqual([])
  })

  it('gives every Modal a name: a ModalHead heading, or label / labelledBy', () => {
    const modals = elements('Modal')
    expect(modals.length).toBeGreaterThanOrEqual(12)
    const unnamed = modals.filter(m => !/\s(label|labelledBy)=/.test(m.tag) && !/<ModalHead\b/.test(m.element)).map(m => m.where)
    expect(unnamed).toEqual([])
  })
})

describe('a row that opens something can be reached from the keyboard', () => {
  /**
   * Clickable, yet not a way to open anything. A handler that only stops the
   * click guards a nested control (the Board card's status select, the table's
   * Delete cell, the editor's AI proposal); the notes surface is typed into.
   */
  const NOT_ACTIVATORS = [/\sonClick=\{\(?e\)? => e\.(stopPropagation|preventDefault)\(\)\}/, /className="notes-editable\b/]

  const clickable = elements('li|tr|td|p|article|div|span|section').filter(e => /\sonClick=/.test(e.tag))

  it('finds the rows it guards', () => {
    expect(clickable.length).toBeGreaterThan(10)
    expect(clickable.filter(e => /\brow-open\b/.test(e.element)).length).toBeGreaterThanOrEqual(10)
  })

  it('gives every clickable element a role, or a row-open title to focus', () => {
    const offenders = clickable
      .filter(e => !/\srole=/.test(e.tag) && !/\brow-open\b/.test(e.element) && !NOT_ACTIVATORS.some(re => re.test(e.tag)))
      .map(e => `${e.where} ${e.tag.replace(/\s+/g, ' ').slice(0, 90)}`)
    expect(offenders).toEqual([])
  })

  it('keeps row-open a bare button, so the row alone decides what a click does', () => {
    const titles = elements('button').filter(e => /className="row-open\b/.test(e.tag))
    expect(titles.length).toBeGreaterThanOrEqual(10)
    for (const t of titles) {
      expect(t.tag, t.where).toMatch(/\stype="button"/)
      expect(t.tag, t.where).not.toMatch(/\son[A-Z]\w*=/)
    }
  })
})

describe('the dialog shell and the top bar stay quiet', () => {
  it('buzzes nowhere in Modal, the modal stack or the top bar', () => {
    // TopBar arrives with the Planner split; until then there is nothing to check there
    for (const rel of ['components/Modal.tsx', 'modalstack.ts', 'components/planner/TopBar.tsx']) {
      const path = join(SRC, rel)
      if (!existsSync(path)) {
        expect(rel).toBe('components/planner/TopBar.tsx')
        continue
      }
      expect(readFileSync(path, 'utf8'), rel).not.toMatch(/haptic\(/)
    }
  })
})
