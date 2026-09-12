import { describe, expect, it, vi } from 'vitest'
import { createModalStack, isComposing, pickReturn, wrapFocus } from '../modalstack'

/** A dialog on the stack; `tabs` is what its Tab handler reports. */
const dialog = (panel: string, tabs = true) => ({ panel, onEscape: vi.fn(), onTab: vi.fn((_backwards: boolean) => tabs) })

describe('Tab stays inside the dialog', () => {
  const controls = ['title', 'notes', 'save']

  it('goes round from the last control to the first', () => {
    expect(wrapFocus(controls, 'save', false, 'panel')).toBe('title')
  })

  it('goes round from the first control back to the last with Shift', () => {
    expect(wrapFocus(controls, 'title', true, 'panel')).toBe('save')
  })

  it('leaves every move that stays inside to the browser', () => {
    expect(wrapFocus(controls, 'title', false, 'panel')).toBeNull()
    expect(wrapFocus(controls, 'notes', false, 'panel')).toBeNull()
    expect(wrapFocus(controls, 'notes', true, 'panel')).toBeNull()
    expect(wrapFocus(controls, 'save', true, 'panel')).toBeNull()
  })

  it('brings focus in from the panel itself, or from the page after its button went', () => {
    expect(wrapFocus(controls, 'panel', false, 'panel')).toBe('title')
    expect(wrapFocus(controls, 'panel', true, 'panel')).toBe('save')
    expect(wrapFocus(controls, null, false, 'panel')).toBe('title')
    expect(wrapFocus(controls, 'body', true, 'panel')).toBe('save')
  })

  it('holds focus on the panel when there is nothing to tab to', () => {
    expect(wrapFocus([], 'panel', false, 'panel')).toBe('panel')
    expect(wrapFocus([], 'body', true, 'panel')).toBe('panel')
  })

  it('keeps a lone control focused either way', () => {
    expect(wrapFocus(['close'], 'close', false, 'panel')).toBe('close')
    expect(wrapFocus(['close'], 'close', true, 'panel')).toBe('close')
  })
})

describe('Escape closes the topmost dialog and no other', () => {
  it('asks only the dialog on top', () => {
    const stack = createModalStack()
    const sheet = dialog('sheet')
    const editor = dialog('editor')
    stack.push(sheet)
    stack.push(editor)
    expect(stack.key({ key: 'Escape' })).toBe(true)
    expect(editor.onEscape).toHaveBeenCalledTimes(1)
    expect(sheet.onEscape).not.toHaveBeenCalled()
  })

  it('passes down the stack as dialogs close, in whatever order they close', () => {
    const stack = createModalStack()
    const a = dialog('a')
    const b = dialog('b')
    const c = dialog('c')
    const offA = stack.push(a)
    stack.push(b)
    const offC = stack.push(c)
    // the bottom one closing first leaves the top on top
    offA()
    stack.key({ key: 'Escape' })
    expect(c.onEscape).toHaveBeenCalledTimes(1)
    offC()
    stack.key({ key: 'Escape' })
    expect(b.onEscape).toHaveBeenCalledTimes(1)
    expect(a.onEscape).not.toHaveBeenCalled()
    expect(stack.size()).toBe(1)
  })

  it('takes a dialog off only once, even if its cleanup runs twice', () => {
    const stack = createModalStack()
    const a = dialog('a')
    const off = stack.push(a)
    stack.push(dialog('b'))
    off()
    off()
    expect(stack.size()).toBe(1)
    expect(stack.owns('b')).toBe(true)
    expect(stack.owns('a')).toBe(false)
  })

  it('does nothing with no dialog open', () => {
    expect(createModalStack().key({ key: 'Escape' })).toBe(false)
  })

  it('leaves an Escape that something inside already handled', () => {
    const stack = createModalStack()
    const a = dialog('a')
    stack.push(a)
    expect(stack.key({ key: 'Escape', defaultPrevented: true })).toBe(false)
    expect(a.onEscape).not.toHaveBeenCalled()
  })

  it('ignores every other key', () => {
    const stack = createModalStack()
    const a = dialog('a')
    stack.push(a)
    expect(stack.key({ key: 'Enter' })).toBe(false)
    expect(stack.key({ key: 'k', metaKey: true })).toBe(false)
    expect(a.onEscape).not.toHaveBeenCalled()
    expect(a.onTab).not.toHaveBeenCalled()
  })
})

describe('Tab is routed to the topmost dialog', () => {
  it('with its direction, and reports what the dialog did with it', () => {
    const stack = createModalStack()
    const under = dialog('under')
    const top = dialog('top', false)
    stack.push(under)
    stack.push(top)
    expect(stack.key({ key: 'Tab', shiftKey: true })).toBe(false)
    expect(top.onTab).toHaveBeenLastCalledWith(true)
    stack.key({ key: 'Tab' })
    expect(top.onTab).toHaveBeenLastCalledWith(false)
    expect(under.onTab).not.toHaveBeenCalled()
  })

  it('but not Ctrl+Tab, Cmd+Tab or Alt+Tab', () => {
    const stack = createModalStack()
    const a = dialog('a')
    stack.push(a)
    expect(stack.key({ key: 'Tab', ctrlKey: true })).toBe(false)
    expect(stack.key({ key: 'Tab', metaKey: true })).toBe(false)
    expect(stack.key({ key: 'Tab', altKey: true })).toBe(false)
    expect(a.onTab).not.toHaveBeenCalled()
  })
})

describe('an input method mid-word keeps its keys', () => {
  it('ignores Escape while composing', () => {
    const stack = createModalStack()
    const a = dialog('a')
    stack.push(a)
    expect(stack.key({ key: 'Escape', isComposing: true })).toBe(false)
    expect(a.onEscape).not.toHaveBeenCalled()
  })

  it('ignores the key that ends a composition in Safari (keyCode 229)', () => {
    const stack = createModalStack()
    const a = dialog('a')
    stack.push(a)
    expect(stack.key({ key: 'Escape', isComposing: false, keyCode: 229 })).toBe(false)
    expect(a.onEscape).not.toHaveBeenCalled()
  })

  it('ignores Tab while composing', () => {
    const stack = createModalStack()
    const a = dialog('a')
    stack.push(a)
    expect(stack.key({ key: 'Tab', isComposing: true })).toBe(false)
    expect(a.onTab).not.toHaveBeenCalled()
  })

  it('reads a plain key as a plain key', () => {
    expect(isComposing({ key: 'Escape', keyCode: 27 })).toBe(false)
  })
})

describe('focus goes back where it came from', () => {
  const live = (el: string) => el !== 'gone'

  it('returns to the opener while it is still on the page', () => {
    expect(pickReturn('cell', 'handed', live)).toBe('cell')
  })

  it('falls back to what the dialog that just closed handed off', () => {
    // the day sheet's Edit button left with the sheet; the editor it opened
    // returns to the day the sheet was opened from
    expect(pickReturn('gone', 'cell', live)).toBe('cell')
  })

  it('returns nowhere rather than to something that has gone', () => {
    expect(pickReturn('gone', 'gone', live)).toBeNull()
    expect(pickReturn(null, null, live)).toBeNull()
  })

  it('keeps a handoff for the current task only', async () => {
    const stack = createModalStack<string, string>()
    stack.handOff('cell')
    expect(stack.handoff()).toBe('cell')
    await Promise.resolve()
    expect(stack.handoff()).toBeNull()
  })

  it('does not let an old handoff clear a newer one', async () => {
    const stack = createModalStack<string, string>()
    let seen: string | null = null
    stack.handOff('first')
    // runs after the first handoff's clear, before the second's
    queueMicrotask(() => {
      seen = stack.handoff()
    })
    stack.handOff('second')
    await Promise.resolve()
    expect(seen).toBe('second')
    expect(stack.handoff()).toBeNull()
  })
})
