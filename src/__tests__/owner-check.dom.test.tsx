// @vitest-environment happy-dom
import { act, render, screen } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Whether this account is the site owner (Admin's button) was asked of
// /api/admin on every auth event — each token refresh, so each return to the
// app — and every ask woke the admin function to say what it had said before.
// It is asked once per account on this install now, and again only when
// another account signs in here. The GitHub board pull, which read every
// board on every return to the app, waits out a few minutes after its last
// pull, as the calendar's does.

const { auth, admin, github } = vi.hoisted(() => ({
  auth: {
    session: null as { user: { id: string } } | null,
    listeners: [] as ((event: string, session: { user: { id: string } } | null) => void)[],
  },
  admin: { answer: vi.fn<() => Promise<{ isOwner: boolean }>>() },
  github: { reads: 0 },
}))

vi.mock('../supabase', () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: auth.session } }),
      onAuthStateChange: (cb: (typeof auth.listeners)[number]) => {
        auth.listeners.push(cb)
        return { data: { subscription: { unsubscribe: () => (auth.listeners = auth.listeners.filter(l => l !== cb)) } } }
      },
    },
  }),
}))
vi.mock('../admin', () => ({ fetchAdminMe: () => admin.answer() }))
vi.mock('../github', async importOriginal => ({
  ...(await importOriginal<typeof import('../github')>()),
  fetchProjectItems: async () => {
    github.reads++
    return { items: [], truncated: false }
  },
}))

import { OWNER_KEY, useOwner } from '../components/planner/useOwner'
import { useGithubProjectSync } from '../githubboard'
import { FOREGROUND_GAP_MS } from '../calendarstate'
import type { Project } from '../types'

const JOE = 'user-joe'
const MARIA = 'user-maria'

function Owner() {
  const { isOwner } = useOwner()
  return <p>{isOwner ? 'owner' : 'member'}</p>
}

const emit = (event: string, userId: string | null) =>
  act(async () => {
    auth.session = userId ? { user: { id: userId } } : null
    for (const l of auth.listeners) l(event, auth.session)
    await Promise.resolve()
  })

beforeEach(() => {
  auth.session = null
  auth.listeners = []
  admin.answer.mockReset()
  admin.answer.mockResolvedValue({ isOwner: true })
})

describe('the owner check', () => {
  it('asks once for an account, however often its token is refreshed or the app comes back', async () => {
    auth.session = { user: { id: JOE } }
    render(<Owner />)
    await screen.findByText('owner')
    for (const event of ['TOKEN_REFRESHED', 'TOKEN_REFRESHED', 'SIGNED_IN', 'USER_UPDATED']) await emit(event, JOE)
    expect(admin.answer).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(OWNER_KEY)!)).toEqual({ userId: JOE, isOwner: true })
  })

  it('a later launch takes the answer this install was given, and asks nothing', async () => {
    localStorage.setItem(OWNER_KEY, JSON.stringify({ userId: JOE, isOwner: true }))
    auth.session = { user: { id: JOE } }
    render(<Owner />)
    await screen.findByText('owner')
    await emit('TOKEN_REFRESHED', JOE)
    expect(admin.answer).not.toHaveBeenCalled()
  })

  it('asks again when another account signs in here, and a sign-out hides Admin at once', async () => {
    localStorage.setItem(OWNER_KEY, JSON.stringify({ userId: JOE, isOwner: true }))
    auth.session = { user: { id: JOE } }
    render(<Owner />)
    await screen.findByText('owner')
    await emit('SIGNED_OUT', null)
    expect(screen.getByText('member')).toBeTruthy()
    admin.answer.mockResolvedValue({ isOwner: false })
    await emit('SIGNED_IN', MARIA)
    await screen.findByText('member')
    await emit('TOKEN_REFRESHED', MARIA)
    expect(admin.answer).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(OWNER_KEY)!)).toEqual({ userId: MARIA, isOwner: false })
  })

  it('an ask that got no answer is not kept, and the next auth event asks again', async () => {
    admin.answer.mockRejectedValueOnce(new Error('offline'))
    auth.session = { user: { id: JOE } }
    render(<Owner />)
    await vi.waitFor(() => expect(admin.answer).toHaveBeenCalledTimes(1))
    expect(screen.getByText('member')).toBeTruthy()
    expect(localStorage.getItem(OWNER_KEY)).toBeNull()
    await emit('TOKEN_REFRESHED', JOE)
    await screen.findByText('owner')
    expect(admin.answer).toHaveBeenCalledTimes(2)
  })

  it('asks once for two auth events that come before the first answer', async () => {
    let answer = (_: { isOwner: boolean }) => {}
    admin.answer.mockImplementation(() => new Promise(r => (answer = r)))
    auth.session = { user: { id: JOE } }
    render(<Owner />)
    await emit('INITIAL_SESSION', JOE)
    await emit('TOKEN_REFRESHED', JOE)
    await act(async () => answer({ isOwner: true }))
    await screen.findByText('owner')
    expect(admin.answer).toHaveBeenCalledTimes(1)
  })
})

describe('the GitHub board pull', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const board = {
    kind: 'project',
    id: 'p1',
    name: 'Home',
    color: '#f97316',
    status: 'active',
    githubUrl: 'https://github.com/users/joe/projects/1',
    githubProjectSync: { statusFieldId: 'f', columns: { todo: 'o1' } },
  } as unknown as Project

  function Board() {
    useGithubProjectSync([board], [], true)
    return null
  }

  const comeBack = async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('reads the boards on launch, not again on a return within a few minutes, and again after', async () => {
    // what a pull loads on its first read, loaded now: the clock below is a stand-in
    await import('../githubsync')
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    github.reads = 0
    render(<Board />)
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(github.reads).toBe(1)
    await comeBack()
    await act(async () => void (await vi.advanceTimersByTimeAsync(FOREGROUND_GAP_MS - 1_000)))
    await comeBack()
    expect(github.reads).toBe(1)
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)))
    await comeBack()
    expect(github.reads).toBe(2)
    // the half-hourly pull still goes, half an hour after launch, and counts as the last one
    await act(async () => void (await vi.advanceTimersByTimeAsync(30 * 60_000 - FOREGROUND_GAP_MS)))
    expect(github.reads).toBe(3)
    await comeBack()
    expect(github.reads).toBe(3)
  })
})
