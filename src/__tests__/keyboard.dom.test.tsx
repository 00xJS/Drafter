// @vitest-environment happy-dom
import './dom'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The iOS keyboard (watchKeyboard in src/native.ts). The shell runs it at
// resize: 'native', so iOS shrinks the web view when the keyboard comes up —
// after WebKit has already scrolled the focused field into view, so a field low
// in a sheet or on the page could end up under the keyboard. Each resize while
// it is up now brings the field being typed back into sight, and only that: a
// field on the sheet or page the reader sees, never a button, nor a field left
// focused behind a sheet. It starts with the app, so the sign-in form has it.

const kb = vi.hoisted(() => ({ listeners: new Map<string, (e: { keyboardHeight?: number }) => void>(), accessoryBar: [] as boolean[] }))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, registerPlugin: () => ({}) }))
vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    setAccessoryBarVisible: async ({ isVisible }: { isVisible: boolean }) => void kb.accessoryBar.push(isVisible),
    addListener: async (name: string, fn: (e: { keyboardHeight?: number }) => void) => {
      kb.listeners.set(name, fn)
      return { remove: async () => void kb.listeners.delete(name) }
    },
  },
}))

import { typingField, watchKeyboard } from '../native'

let stop: () => void = () => {}
let scrolled: { el: Element; opts: unknown }[] = []

beforeEach(async () => {
  kb.listeners.clear()
  kb.accessoryBar = []
  scrolled = []
  // happy-dom lays nothing out; what matters is which element is asked, and how
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement, opts?: unknown) {
    scrolled.push({ el: this, opts })
  })
  stop = await watchKeyboard()
})
afterEach(() => {
  stop()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const keyboardUp = (h = 336) => kb.listeners.get('keyboardWillShow')!({ keyboardHeight: h })
const keyboardDown = () => kb.listeners.get('keyboardWillHide')!({})
const resize = () => window.dispatchEvent(new Event('resize'))

function page(html: string) {
  document.body.innerHTML = html
}

describe('the field being typed stays in sight as the web view shrinks', () => {
  it('scrolls the focused field into view, the least distance, on each resize while the keyboard is up', () => {
    page('<main id="root"><form><input id="name" type="text"></form></main>')
    const field = document.getElementById('name') as HTMLInputElement
    field.focus()
    keyboardUp()
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true)
    resize()
    resize()
    expect(scrolled).toEqual([
      { el: field, opts: { block: 'nearest' } },
      { el: field, opts: { block: 'nearest' } },
    ])
  })

  it('does nothing once the keyboard is down, or before it came up', () => {
    page('<textarea id="note"></textarea>')
    document.getElementById('note')!.focus()
    resize()
    keyboardUp()
    keyboardDown()
    resize()
    expect(scrolled).toEqual([])
  })

  it('in a sheet, only for a field on the topmost one', () => {
    page(`
      <main><input id="behind" type="search"></main>
      <div role="dialog" aria-modal="true"><textarea id="sheet"></textarea></div>
      <div role="dialog" aria-modal="true"><input id="top" type="email"></div>`)
    keyboardUp()
    for (const id of ['behind', 'sheet']) {
      document.getElementById(id)!.focus()
      resize()
    }
    expect(scrolled).toEqual([])
    document.getElementById('top')!.focus()
    resize()
    expect(scrolled.map(s => (s.el as HTMLElement).id)).toEqual(['top'])
  })

  it('never for a button, a checkbox, a read-only field or one the lock has made inert', () => {
    page(`
      <button id="b">Save</button>
      <input id="c" type="checkbox">
      <input id="r" type="text" readonly>
      <div inert><input id="i" type="text"></div>
      <div contenteditable="true" id="rich"></div>`)
    keyboardUp()
    for (const id of ['b', 'c', 'r', 'i']) {
      const el = document.getElementById(id)!
      el.focus()
      expect(typingField(el), id).toBeNull()
      resize()
    }
    expect(scrolled).toEqual([])
    // a rich-text field is typed into like any other
    const rich = document.getElementById('rich')!
    Object.defineProperty(rich, 'isContentEditable', { value: true })
    rich.focus()
    resize()
    expect(scrolled.map(s => s.el)).toEqual([rich])
  })

  it('lets go when stopped', () => {
    page('<input id="name" type="text">')
    document.getElementById('name')!.focus()
    keyboardUp()
    stop()
    resize()
    expect(scrolled).toEqual([])
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false)
  })
})

describe('it starts with the app', () => {
  // happy-dom's URL is not node's: the path is worked out by node's own
  const read = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8')

  it('gives every multi-line field its Done bar', () => {
    expect(kb.accessoryBar).toEqual([true])
  })

  it('from main.tsx, before anything is signed in to, and not again with the planner', () => {
    expect(read('main.tsx')).toMatch(/^void watchKeyboard\(\)$/m)
    const init = /export async function initNative[\s\S]*?\n\}\n/.exec(read('native.ts'))?.[0] ?? ''
    expect(init).toContain('watchTextSize()')
    expect(init).not.toContain('watchKeyboard()')
  })
})
