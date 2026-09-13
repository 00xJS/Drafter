import type { ReactElement, ReactNode, SetStateAction } from 'react'
import { describe, expect, it } from 'vitest'
import { Toast } from '../components/planner/Toast'
import type { Toast as ToastState } from '../components/planner/routes'

/*
 * A toast button does its work and then closes the toast it sits on. The work
 * can put up a toast of its own: Add on a journal offer says "Added to today's
 * journal" with an Undo, Saw them says "Logged a visit", and closing afterwards
 * wiped that confirmation the moment it appeared. Toast holds no hooks, so it
 * is called here as the function it is, its buttons pressed through their
 * onClick, against a stand-in for useToast's state.
 */

type ButtonProps = { children?: ReactNode; onClick?: () => void; 'aria-label'?: string }

/** Every button in a rendered toast: its name (aria-label, else its text) and its click. */
function buttonsIn(node: ReactNode): { name: string; click: () => void }[] {
  if (Array.isArray(node)) return node.flatMap(buttonsIn)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const el = node as ReactElement<ButtonProps>
  if (el.type === 'button') return [{ name: el.props['aria-label'] ?? String(el.props.children), click: () => el.props.onClick?.() }]
  return buttonsIn(el.props.children)
}

/** useToast's state and showToast (its timer aside), each update applied in order, as React applies the ones a click queues. */
function toaster() {
  let current: ToastState | null = null
  const setToast = (next: SetStateAction<ToastState | null>) => {
    current = typeof next === 'function' ? next(current) : next
  }
  return {
    get current() {
      return current
    },
    showToast: (msg: string, undo?: () => void, action?: ToastState['action']) => setToast({ msg, undo, action }),
    /** Press a button on the toast now showing. */
    press(name: string) {
      const button = buttonsIn(Toast({ toast: current, setToast })).find(b => b.name === name)
      if (!button) throw new Error(`no ${name} button on the toast ${JSON.stringify(current?.msg ?? null)}`)
      button.click()
    },
  }
}

describe('a toast button whose work puts up a toast leaves that toast up', () => {
  it('Add on a journal offer leaves "Added to today’s journal", with an Undo that works', () => {
    const t = toaster()
    let undone = 0
    t.showToast('Add to today’s journal: “Hi”', undefined, { label: 'Add', run: () => t.showToast('Added to today’s journal', () => undone++) })
    t.press('Add')
    expect(t.current?.msg).toBe('Added to today’s journal')
    t.press('Undo')
    expect(undone).toBe(1)
    expect(t.current).toBeNull()
  })

  it('Saw them leaves "Logged a visit with Sam"', () => {
    const t = toaster()
    t.showToast('Log a visit with Sam?', undefined, { label: 'Saw them', run: () => t.showToast('Logged a visit with Sam', () => {}) })
    t.press('Saw them')
    expect(t.current?.msg).toBe('Logged a visit with Sam')
  })

  it('an Undo that says what it did leaves that up too', () => {
    const t = toaster()
    t.showToast('Deleted “Milk”', () => t.showToast('Restored “Milk”'))
    t.press('Undo')
    expect(t.current?.msg).toBe('Restored “Milk”')
  })

  it('tells a newer toast by identity, so the same words twice are still two toasts', () => {
    const t = toaster()
    t.showToast('Saved', undefined, { label: 'Again', run: () => t.showToast('Saved') })
    const first = t.current
    t.press('Again')
    expect(t.current?.msg).toBe('Saved')
    expect(t.current).not.toBe(first)
  })
})

describe('a toast button whose work says nothing still closes its toast', () => {
  it('closes on a confirm step', () => {
    const t = toaster()
    let kept = 0
    t.showToast('Another device changed this too', undefined, { label: 'Keep mine', run: () => kept++ })
    t.press('Keep mine')
    expect(kept).toBe(1)
    expect(t.current).toBeNull()
  })

  it('closes on Undo', () => {
    const t = toaster()
    let undone = 0
    t.showToast('Moved to tomorrow', () => undone++)
    t.press('Undo')
    expect(undone).toBe(1)
    expect(t.current).toBeNull()
  })

  it('closes on Dismiss, whatever is showing', () => {
    const t = toaster()
    t.showToast('Added to today’s journal', () => {})
    t.press('Dismiss')
    expect(t.current).toBeNull()
  })
})
