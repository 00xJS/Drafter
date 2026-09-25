// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from './dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The bell's "Turn on" for this device. A notice always lands in the bell,
// but it reaches the lock screen only once this device has asked for pushes —
// and both phones had never been asked, so a finished task or a household
// message waited in the bell. The nudge speaks only when the server can push
// and this device is not yet one of the account's subscriptions.

const push = vi.hoisted(() => ({
  pushSupported: vi.fn(() => true),
  fetchPushInfo: vi.fn(),
  currentEndpoint: vi.fn(),
  enablePush: vi.fn(),
  testPush: vi.fn(),
}))
vi.mock('../push', () => push)

import { PushNudge } from '../components/PushNudge'

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

/** Let the effect's two answers arrive, then say whether the nudge is showing. */
async function shown(): Promise<boolean> {
  await waitFor(() => expect(push.currentEndpoint).toHaveBeenCalled())
  await new Promise(r => setTimeout(r, 0))
  return screen.queryByRole('status') !== null
}

describe('the bell offers push to a device that has not asked for it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    push.pushSupported.mockReturnValue(true)
    push.currentEndpoint.mockResolvedValue(null)
  })

  it('offers Turn on while this device is not among the subscriptions, and turns it on', async () => {
    push.fetchPushInfo.mockResolvedValue(info({ subscriptions: ['apns:the-other-phone'] }))
    push.enablePush.mockResolvedValue(['apns:the-other-phone', 'apns:this-phone'])
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await screen.findByText('Notifications are on for this device.')
    expect(push.enablePush).toHaveBeenCalledWith('pk')
  })

  it('then sends a test when asked', async () => {
    push.fetchPushInfo.mockResolvedValue(info())
    push.enablePush.mockResolvedValue(['apns:this-phone'])
    push.testPush.mockResolvedValue({ sent: 1 })
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
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

  it('keeps the offer, and says why, when turning on fails', async () => {
    push.fetchPushInfo.mockResolvedValue(info())
    push.enablePush.mockRejectedValue(new Error('Notifications were not allowed.'))
    render(<PushNudge />)
    expect(await shown()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await screen.findByText('Notifications were not allowed.')
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  })
})
