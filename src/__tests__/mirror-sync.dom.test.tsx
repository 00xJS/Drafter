// @vitest-environment happy-dom
import { act, render, waitFor } from './dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '../types'

// The Google and Outlook mirrors' hook (useMirrorSync, calendarstate.ts),
// mounted as the shell mounts it, with the mirror engine a stand-in that
// writes down each pass it is asked for. It runs as the React Compiler
// builds it, as every DOM test does.

const engine = vi.hoisted(() => ({ passes: [] as { targets: string[]; pull: boolean }[] }))
vi.mock('../calendars', () => ({
  passTarget: (spec: { id: string }) => ({ id: spec.id }),
  mirrorPass: async (targets: { id: string }[], _items: unknown, _names: unknown, _myId: unknown, opts: { pull: boolean }) => {
    engine.passes.push({ targets: targets.map(t => t.id), pull: opts.pull })
    return { accountErrors: {}, waiting: 0, more: false, failed: false, notices: {}, signIn: {} }
  },
}))

import { clearMirrorSignIn, useGooglePush, type GooglePushState } from '../calendarstate'

const NO_ITEMS: Item[] = []
const NO_PROJECTS: never[] = []

/** The hook as the shell holds it, and every state it handed back, in order. */
function mount() {
  const seen: GooglePushState[] = []
  function Shell({ tick }: { tick: number }) {
    seen.push(useGooglePush(NO_ITEMS, NO_PROJECTS, true, undefined, 'me'))
    return <p>{tick}</p>
  }
  const view = render(<Shell tick={0} />)
  return { seen, again: (tick: number) => view.rerender(<Shell tick={tick} />) }
}

afterEach(() => {
  engine.passes = []
})

describe('the calendar mirror', () => {
  it('asks again once a dead sign-in is mended, though the pass before had nothing to ask', async () => {
    // Google's sign-in died an hour ago: not asked again for a day
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    localStorage.setItem('drafter:mirror-signin:google:me', JSON.stringify({ since: hourAgo, message: 'Sign in to Google again', triedAt: hourAgo }))
    mount()
    await act(async () => {})
    expect(engine.passes).toEqual([])
    // Settings finds the account connected again: the mirror asks at once
    act(() => clearMirrorSignIn('google'))
    await waitFor(() => expect(engine.passes).toEqual([{ targets: ['google'], pull: true }]))
  })

  it('hands back the same state from render to render until something in it changes', async () => {
    const { seen, again } = mount()
    await waitFor(() => expect(engine.passes).toHaveLength(1))
    await waitFor(() => expect(seen[seen.length - 1].pending).toBe(false))
    const settled = seen[seen.length - 1]
    again(1)
    again(2)
    expect(seen[seen.length - 1]).toBe(settled)
    expect(seen[seen.length - 1].pullNow).toBe(settled.pullNow)
  })
})
