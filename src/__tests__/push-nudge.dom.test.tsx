// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from './dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The bell's "Turn on for this device". A notice always lands in the bell,
// but it reaches the lock screen only once this device has asked for pushes —
// and both phones had never been asked, so a finished task or a household
// message waited in the bell. The nudge speaks only when the server can push
// and this device is not yet one of the account's subscriptions; "Not now"
// puts it away on this device, and where iOS or the browser has already said
// no, it says where to turn notifications on instead of asking again.

const push = vi.hoisted(() => ({
  pushSupported: vi.fn(() => true),
  fetchPushInfo: vi.fn(),
  currentEndpoint: vi.fn(),
  pushPermission: vi.fn(),
  enablePush: vi.fn(),
  testPush: vi.fn(),
}))
vi.mock('../push', () => push)
const shell = vi.hoisted(() => ({ native: false }))
vi.mock('../native', () => ({ isNative: () => shell.native, APP_SETTINGS_URL: 'app-settings:' }))

import { PUSH_NUDGE_NOT_NOW_KEY, PushNudge, TURN_ON } from '../components/PushNudge'

const info = (over: Record<string, unknown> = {}) => ({
  configured: true,
  missing: [],
  webPush: true,
  apns: true,
  publicKey: 'pk',
  subscriptions: [] as string[],
  digestEmail: false,
  digestHour: 8,
  ...over,
})

/** Let the effect's answers arrive, then say whether the nudge is showing. */
async function shown(): Promise<boolean> {
  await waitFor(() => expect(push.pushPermission).toHaveBeenCalled())
  await new Promise(r => setTimeout(r, 0))
  return screen.queryByRole('status') !== null
}

beforeEach(() => {
  vi.clearAllMocks()
  shell.native = false
  push.pushSupported.mockReturnValue(true)
  push.currentEndpoint.mockResolvedValue(null)
  push.pushPermission.mockResolvedValue('prompt')
})

describe('the bell offers push to a device that has not asked for it', () => {
  it('offers to turn it on while this device is not among the subscriptions, and turns it on', async () => {
    push.fetchPushInfo.mockResolvedValue(info({ subscriptions: ['apns:the-other-phone'] }))
    push.enablePush.mockResolvedValue(['apns:the-other-phone', 'apns:this-phone'])
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: TURN_ON }))
    await screen.findByText('Notifications are on for this device.')
    expect(push.enablePush).toHaveBeenCalledWith('pk')
  })

  it('then sends a test when asked', async () => {
    push.fetchPushInfo.mockResolvedValue(info())
    push.enablePush.mockResolvedValue(['apns:this-phone'])
    push.testPush.mockResolvedValue({ sent: 1 })
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: TURN_ON }))
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }))
    await screen.findByText('A test is on its way.')
    expect(push.testPush).toHaveBeenCalledTimes(1)
  })

  it('says nothing once this device is subscribed', async () => {
    push.fetchPushInfo.mockResolvedValue(info({ subscriptions: ['apns:this-phone'] }))
    push.currentEndpoint.mockResolvedValue('apns:this-phone')
    render(<PushNudge />)
    expect(await shown()).toBe(false)
  })

  it('says nothing when the server cannot push at all', async () => {
    push.fetchPushInfo.mockResolvedValue(info({ configured: false }))
    render(<PushNudge />)
    expect(await shown()).toBe(false)
  })

  it('says nothing where push cannot work, or the server cannot be reached', async () => {
    push.pushSupported.mockReturnValue(false)
    const { unmount } = render(<PushNudge />)
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByRole('status')).toBeNull()
    expect(push.fetchPushInfo).not.toHaveBeenCalled()
    unmount()

    push.pushSupported.mockReturnValue(true)
    push.fetchPushInfo.mockRejectedValue(new Error('offline'))
    render(<PushNudge />)
    expect(await shown()).toBe(false)
  })

  it('keeps the offer, and says why, when turning on fails for another reason', async () => {
    push.fetchPushInfo.mockResolvedValue(info())
    push.enablePush.mockRejectedValue(new Error('The service worker is not ready yet. Reload the page and try again.'))
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: TURN_ON }))
    await screen.findByText('The service worker is not ready yet. Reload the page and try again.')
    expect(screen.getByRole('button', { name: TURN_ON })).toBeTruthy()
  })
})

describe('Not now', () => {
  it('puts the nudge away, and this device remembers: it is not offered here again', async () => {
    push.fetchPushInfo.mockResolvedValue(info())
    const { unmount } = render(<PushNudge />)
    expect(await shown()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(localStorage.getItem(PUSH_NUDGE_NOT_NOW_KEY)).toBeTruthy()
    unmount()
    // the next time the bell is opened, nothing is asked and nothing shown
    vi.clearAllMocks()
    render(<PushNudge />)
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByRole('status')).toBeNull()
    expect(push.fetchPushInfo).not.toHaveBeenCalled()
  })

  it('still puts it away when this device will not keep anything', async () => {
    push.fetchPushInfo.mockResolvedValue(info())
    const refuse = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    try {
      render(<PushNudge />)
      expect(await shown()).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      refuse.mockRestore()
      read.mockRestore()
    }
  })
})

describe('where iOS or the browser has said no', () => {
  it('says where to turn notifications on in iPhone Settings, rather than asking again', async () => {
    shell.native = true
    push.pushPermission.mockResolvedValue('denied')
    push.fetchPushInfo.mockResolvedValue(info())
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Turn them on in iPhone Settings → Notifications → Drafter.')
    expect(screen.queryByRole('button', { name: TURN_ON })).toBeNull()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    // and a way there: Drafter's own page in the Settings app, which the shell hands to iOS
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('app-settings:')
  })

  it('in a browser, says where that browser keeps the switch', async () => {
    push.pushPermission.mockResolvedValue('denied')
    push.fetchPushInfo.mockResolvedValue(info())
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Allow them in the browser’s settings for this site.')
    expect(screen.queryByRole('button', { name: TURN_ON })).toBeNull()
    // a browser's site settings have no address to open
    expect(screen.queryByRole('link', { name: 'Open Settings' })).toBeNull()
  })

  it('says so as soon as the answer is no, and offers it again once it is turned on in Settings', async () => {
    shell.native = true
    push.fetchPushInfo.mockResolvedValue(info())
    push.enablePush.mockRejectedValue(new Error('Notifications were not allowed. Turn them on in the iPhone Settings app, under Drafter.'))
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    push.pushPermission.mockResolvedValue('denied')
    fireEvent.click(screen.getByRole('button', { name: TURN_ON }))
    await screen.findByText(/Turn them on in iPhone Settings → Notifications → Drafter\./)
    expect(screen.queryByRole('button', { name: TURN_ON })).toBeNull()
    // back from the Settings app, with notifications allowed there
    push.pushPermission.mockResolvedValue('granted')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(await screen.findByRole('button', { name: TURN_ON })).toBeTruthy()
  })
})

describe('one phrase for one switch', () => {
  it('is the words Settings → Notifications uses for it too', () => {
    // read from the checkout: a document's module URL is not a file one
    const settings = readFileSync(join(process.cwd(), 'src/components/settings/Reminders.tsx'), 'utf8')
    expect(TURN_ON).toBe('Turn on for this device')
    expect(settings).toContain("pushBusy ? 'Turning on…' : TURN_ON")
    expect(settings).not.toMatch(/Enable on this device|Enabling…/)
  })
})
