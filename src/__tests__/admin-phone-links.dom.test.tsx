// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Admin's links, after a round trip to the server. WebKit — the iPhone app's
// web view — lets the clipboard be written, and a window be opened, only
// inside the tap itself, and the server's answer comes long after it: in the
// app, the automatic copy and the automatic open did nothing at all. There the
// link is shown with its Copy or Open button, which work because they are the
// tap, and a line says so. A browser still copies and opens straight away.

const env = vi.hoisted(() => ({ native: true }))
const actions = vi.hoisted(() => ({ adminAction: vi.fn() }))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') }, registerPlugin: () => ({}) }))
vi.mock('@capacitor/browser', () => ({ Browser: { open: async () => {} } }))
vi.mock('../admin', () => actions)

import type { AdminStatus, AdminUser, BackupList } from '../admin'
import { Admin } from '../components/Admin'

const OWNER = '907ec8ad-a40a-47c1-8a0f-16ff7243ba87'
const user = (id: string, email: string): AdminUser => ({ id, email, createdAt: null, lastSignInAt: null, confirmedAt: null, disabled: false, bannedUntil: null })
const piece = { configured: true, missing: [] }
const STATUS: AdminStatus = { google: piece, microsoft: piece, vapid: piece, apns: piece, ai: piece, github: piece, resend: piece, owner: { configured: true, email: 'owner@example.com' } }
const BACKUPS: BackupList = {
  users: [{ userId: OWNER, email: 'owner@example.com', bytes: 1200, files: [{ name: '2026-09-22.json', path: `backups/${OWNER}/2026-09-22.json`, date: '2026-09-22', size: 1200, updatedAt: null }] }],
  totalFiles: 1,
  totalBytes: 1200,
  lastBackupAt: '2026-09-22T10:00:00.000Z',
  keep: 14,
}
const RESET = 'https://example.supabase.co/auth/v1/verify?token=reset'
const SIGNED = 'https://example.supabase.co/storage/v1/object/sign/media/backups/x.json?token=t'

let copied: string[] = []
let opened: string[] = []

beforeEach(() => {
  env.native = true
  copied = []
  opened = []
  actions.adminAction.mockReset()
  actions.adminAction.mockImplementation(async (action: string) => (action === 'downloadBackup' ? { url: SIGNED } : { actionLink: RESET }))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } })
  vi.spyOn(window, 'open').mockImplementation((url?: string | URL) => {
    opened.push(String(url))
    return null
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

const admin = (group: 'users' | 'backups') =>
  render(<Admin initialGroup={group} initial={{ users: [user(OWNER, 'owner@example.com')], ownerEmail: 'owner@example.com', status: STATUS, backups: BACKUPS }} />)

async function makeResetLink() {
  fireEvent.change(screen.getByRole('combobox', { name: /Account/ }), { target: { value: 'owner@example.com' } })
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Link only' })))
  await waitFor(() => expect(screen.getByDisplayValue(RESET)).toBeTruthy())
}

describe('in the iPhone app', () => {
  it('shows a reset link with its Copy button, and copies it on the tap, not before', async () => {
    admin('users')
    await makeResetLink()
    expect(copied).toEqual([])
    expect(screen.getByText('Tap Copy to put the link on the clipboard.')).toBeTruthy()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
    expect(copied).toEqual([RESET])
    expect(screen.queryByText('Tap Copy to put the link on the clipboard.')).toBeNull()
  })

  it('opens no window for a backup’s download, and offers its Open under the row', async () => {
    admin('backups')
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Download' })))
    await waitFor(() => expect(screen.getByDisplayValue(SIGNED)).toBeTruthy())
    expect(opened).toEqual([])
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(SIGNED)
    expect(screen.getByText('Tap Open to fetch the file.')).toBeTruthy()
  })
})

describe('in a browser', () => {
  beforeEach(() => {
    env.native = false
  })

  it('still copies a link and opens a download straight away, with no line about the buttons', async () => {
    admin('users')
    await makeResetLink()
    expect(copied).toEqual([RESET])
    expect(screen.queryByText('Tap Copy to put the link on the clipboard.')).toBeNull()
  })

  it('opens a download at once', async () => {
    admin('backups')
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Download' })))
    await waitFor(() => expect(opened).toEqual([SIGNED]))
    expect(screen.queryByText('Tap Open to fetch the file.')).toBeNull()
  })
})
