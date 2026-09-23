// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Signing out wipes this device, so every sign-out the person starts asks
// first while a photo is waiting to upload, and then goes in one order: push
// off while the session can still deregister it, the session, this device's
// copy, the reload. Clicked through here with the session, the push service,
// the media store and the wipe as stand-ins that write down what they were
// asked; the last part runs the real wipe against this document's storage.

const did = vi.hoisted(() => ({ log: [] as string[], waiting: 0 }))
vi.mock('../push', () => ({ disablePush: vi.fn(async () => void did.log.push('push off')) }))
vi.mock('../supabase', () => ({
  getSupabase: () => ({
    auth: {
      signOut: async () => void did.log.push('session'),
      getSession: async () => ({ data: { session: { user: { email: 'me@example.test' } } } }),
    },
  }),
}))
vi.mock('../idb', () => ({ clearLocalData: vi.fn(async () => void did.log.push('wipe')) }))
vi.mock('../media', () => ({
  unsentPhotoCount: vi.fn(async () => did.waiting),
  flushPendingMedia: vi.fn(async () => 0),
}))
vi.mock('../store', () => ({ syncIfStarted: vi.fn(async () => true) }))
vi.mock('../household', () => ({ householdAction: vi.fn() }))

import { ConnectAssistantSheet } from '../components/ConnectAssistantSheet'
import { Account } from '../components/settings/Household'
import type { SettingsCtx } from '../components/settings/context'
import { UnsentPhotosSheet } from '../components/SignOutGuard'
import { expiredLine, unsentLine } from '../signout'

const THE_ORDER = ['push off', 'session', 'wipe', 'closed', 'reload']

beforeEach(() => {
  did.log = []
  did.waiting = 0
  vi.spyOn(window.location, 'reload').mockImplementation(() => void did.log.push('reload'))
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** Settings → You → Account, signed in; `authError`: the session has expired. */
function account(authError = false) {
  const ctx = { supabaseOn: true, onClose: () => void did.log.push('closed'), store: { syncInfo: { authError } } } as unknown as SettingsCtx
  render(<Account {...ctx} />)
}

describe('Settings → Account → Sign out', () => {
  it('with every photo up, signs out at once: push off, the session, this device’s copy, the reload', async () => {
    account()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(did.log).toEqual(THE_ORDER))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('with photos waiting, asks first and touches nothing until it is answered', async () => {
    did.waiting = 3
    account()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    const sheet = await screen.findByRole('dialog', { name: 'Sign out?' })
    expect(sheet.textContent).toContain(unsentLine(3))
    expect(did.log).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(did.log).toEqual(THE_ORDER))
  })

  it('Cancel keeps the session and this device’s copy, and the next tap asks again', async () => {
    did.waiting = 2
    account()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('dialog', { name: 'Sign out?' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('dialog', { name: 'Sign out?' })).toBeTruthy()
    expect(did.log).toEqual([])
  })

  it('once the session has expired, says nothing can upload first, and offers no try', async () => {
    did.waiting = 1
    account(true)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    const sheet = await screen.findByRole('dialog', { name: 'Sign out?' })
    expect(sheet.textContent).toContain(expiredLine(1))
    expect(screen.queryByRole('button', { name: 'Try uploading now' })).toBeNull()
  })
})

describe('the question: Escape, the backdrop and ✕ are Cancel', () => {
  const sheet = (busy: 'uploading' | 'signing-out' | null) => {
    const onCancel = vi.fn()
    render(<UnsentPhotosSheet count={2} tried={false} busy={busy} onUpload={() => {}} onSignOut={() => {}} onCancel={onCancel} />)
    const backdrop = document.querySelector('.modal-backdrop')!
    return { onCancel, backdrop }
  }

  it('while nothing runs, and while an upload is tried: the upload carries on behind it', () => {
    for (const busy of [null, 'uploading'] as const) {
      const { onCancel, backdrop } = sheet(busy)
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      fireEvent.mouseDown(backdrop)
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(onCancel, String(busy)).toHaveBeenCalledTimes(3)
      document.body.innerHTML = ''
    }
  })

  it('but not while the sign-out itself runs: every answer is held', () => {
    const { onCancel, backdrop } = sheet('signing-out')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.mouseDown(backdrop)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onCancel).not.toHaveBeenCalled()
    for (const name of ['Signing out…', 'Cancel', 'Try uploading now']) expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true)
  })
})

describe('the assistant consent sheet’s Sign out ("Not you?")', () => {
  const ask = async (onSignOut: () => Promise<void>) => {
    const describeRequest = async () => ({ ok: true as const, clientName: 'Claude', redirectHost: 'claude.ai', loopback: false, requestedScopes: ['read' as const], existingConnectionId: null })
    render(<ConnectAssistantSheet params={new URLSearchParams('client_id=x')} email="me@example.test" onDone={() => {}} onSignOut={onSignOut} describe={describeRequest} />)
    await screen.findByRole('dialog', { name: 'Connect Claude?' })
    return screen.getByRole('button', { name: 'Sign out' })
  }

  it('asks about waiting photos too, and is held until the sign-out itself is done', async () => {
    did.waiting = 1
    let finish = () => {}
    const onSignOut = vi.fn(() => new Promise<void>(resolve => (finish = resolve)))
    const button = await ask(onSignOut)
    fireEvent.click(button)
    expect(await screen.findByRole('dialog', { name: 'Sign out?' })).toBeTruthy()
    expect(onSignOut).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1))
    // the sheet's own button stays held while the sign-out runs
    expect(button).toHaveProperty('disabled', true)
    await act(async () => finish())
  })
})

/*
 * What a sign-out leaves behind: the real wipe (src/idb.ts), run on this
 * document's localStorage and a stand-in IndexedDB. Two keys describe the
 * screen and not the person, and survive: the colour it is painted in and
 * which of Home's headings are folded (the owner asked for the folds to
 * survive a login). Anything that names a record, a person, a place, a date,
 * a count or a habit of use is the person's, and goes.
 */
describe('what survives a sign-out', () => {
  const KEPT = { 'drafter:theme': 'dark', 'drafter:home-folded': '["coming-up"]' }
  const GONE = [
    'drafter:household',
    'drafter:chat-seen',
    'drafter:dirty-ids',
    'drafter:sync-cursor',
    'drafter:kitchen-recipes',
    'drafter:keep-tab',
    'drafter:tasks-tab',
    'drafter:insights-tab',
    'drafter:calendar-mode',
    'drafter:app-lock',
    'drafter:weather',
  ]

  it('keeps the two display settings, and every other drafter key goes, with the database', async () => {
    const deleted: string[] = []
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('no database in this test')
      },
      deleteDatabase: (name: string) => {
        deleted.push(name)
        const req: { onsuccess?: () => void } = {}
        queueMicrotask(() => req.onsuccess?.())
        return req
      },
    })
    localStorage.clear()
    for (const [key, value] of Object.entries(KEPT)) localStorage.setItem(key, value)
    for (const key of GONE) localStorage.setItem(key, 'x')
    localStorage.setItem('another-app:setting', 'kept')
    const { clearLocalData } = await vi.importActual<typeof import('../idb')>('../idb')
    await clearLocalData()
    const left = Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).map(k => [k, localStorage.getItem(k)]))
    expect(left).toEqual({ ...KEPT, 'another-app:setting': 'kept' })
    expect(deleted).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('the folds are a list of section names and nothing else, whatever the key held', async () => {
    const { readFolded, writeFolded } = await import('../homefolds')
    writeFolded(['coming-up', 'done'])
    expect(JSON.parse(localStorage.getItem('drafter:home-folded')!)).toEqual(['coming-up', 'done'])
    localStorage.setItem('drafter:home-folded', JSON.stringify(['done', 7, { title: 'Call Mum' }]))
    expect(readFolded()).toEqual(['done'])
  })
})
