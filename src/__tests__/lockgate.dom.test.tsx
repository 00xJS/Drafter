// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from './dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The app lock (Settings → Reminders → Lock this iPhone) as the planner meets
// it: mounted over the planner, woken by a resume, unlocked by Face ID. The
// bridge to iOS is a stand-in whose answers each test chooses.

const lock = vi.hoisted(() => ({
  on: false,
  resume: null as null | (() => void),
  answers: [] as ((ok: boolean) => void)[],
  reasons: [] as string[],
  showing: [] as boolean[],
}))
vi.mock('../native', () => ({
  appLockEnabled: () => lock.on,
  watchAppLock: vi.fn(async (onLock: () => void) => {
    lock.resume = onLock
    return () => {
      lock.resume = null
    }
  }),
  checkAppLock: vi.fn(async () => ({ available: true, label: 'Face ID' })),
  authenticateAppLock: vi.fn((reason: string) => {
    lock.reasons.push(reason)
    return new Promise<boolean>(resolve => lock.answers.push(resolve))
  }),
  setAppLockShowing: vi.fn((on: boolean) => void lock.showing.push(on)),
}))

import { LockGate } from '../components/LockGate'

/** The planner and the lock, side by side under #root, as App draws them. */
function mount() {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  render(
    <>
      <main className="planner">
        <button type="button">New task</button>
      </main>
      <LockGate />
    </>,
    { container: root },
  )
  return { planner: root.querySelector('main')! }
}

/** Face ID's answer to the newest question it was asked. */
const answer = (ok: boolean) => act(() => lock.answers.at(-1)!(ok))

beforeEach(() => {
  lock.on = false
  lock.resume = null
  lock.answers = []
  lock.reasons = []
  lock.showing = []
  document.body.innerHTML = ''
})

describe('the app lock over the planner', () => {
  it('stays out of the way while the lock is off, and still listens for a resume', async () => {
    const { planner } = mount()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(planner.inert).toBe(false)
    // turned on in Settings mid-session: the next resume must lock, with no cold start between
    await waitFor(() => expect(lock.resume).not.toBeNull())
    lock.on = true
    act(() => lock.resume!())
    expect(screen.getByRole('dialog', { name: 'Drafter is locked' })).toBeTruthy()
    expect(planner.inert).toBe(true)
  })

  it('opens locked, with the planner inert behind it and the card focused, and asks Face ID at once', async () => {
    lock.on = true
    const { planner } = mount()
    expect(screen.getByRole('dialog', { name: 'Drafter is locked' })).toBeTruthy()
    // Enter must not press a button nobody can see
    expect(planner.inert).toBe(true)
    expect(document.activeElement?.className).toBe('lock-card')
    expect(lock.showing).toEqual([true])
    await waitFor(() => expect(lock.reasons).toEqual(['Unlock Drafter']))
    expect(await screen.findByRole('button', { name: 'Unlock with Face ID' })).toBeTruthy()
  })

  it('lets the planner back in when Face ID says yes', async () => {
    lock.on = true
    const { planner } = mount()
    await waitFor(() => expect(lock.answers).toHaveLength(1))
    await answer(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(planner.inert).toBe(false)
    // clearing the flag is what replays a link the lock held back
    expect(lock.showing).toEqual([true, false])
  })

  it('stays locked when Face ID says no, says so, and tries again on the button', async () => {
    lock.on = true
    mount()
    await waitFor(() => expect(lock.answers).toHaveLength(1))
    await answer(false)
    expect(screen.getByRole('dialog', { name: 'Drafter is locked' })).toBeTruthy()
    const button = await screen.findByRole('button', { name: 'Unlock with Face ID' })
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Waiting…' })).toHaveProperty('disabled', true)
    expect(lock.reasons.at(-1)).toBe('Unlock Drafter with Face ID')
    await answer(false)
    expect(screen.getByText('Couldn’t unlock. Try again, or use the device passcode.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unlock with Face ID' }))
    await answer(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
