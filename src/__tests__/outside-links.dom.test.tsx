// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Links that leave the app. In the iOS shell a bare target="_blank" is handed
// to the Safari app, and coming back after the lock's grace asks for Face ID.
// A GitHub card's title and a backup's Open now go through openExternal, as a
// task's own links already did: Safari's sheet, over the app, on the iPhone.

const env = vi.hoisted(() => ({ native: true, opened: [] as string[] }))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') }, registerPlugin: () => ({}) }))
vi.mock('@capacitor/browser', () => ({ Browser: { open: async ({ url }: { url: string }) => void env.opened.push(url) } }))
// the card's live status needs GitHub; its title is drawn from the address before that answers
vi.mock('../github', async importOriginal => ({ ...(await importOriginal<typeof import('../github')>()), fetchGithubCard: () => new Promise(() => {}) }))

import { SnapshotFiles } from '../components/AdminBackups'
import { GithubCard } from '../components/GithubCard'

beforeEach(() => {
  env.native = true
  env.opened = []
})

/** Let the dynamic import of the Browser plugin land. */
const settle = () => new Promise(r => setTimeout(r, 0))

describe('a GitHub card’s title', () => {
  it('opens in Safari’s sheet over the app, not the Safari app', async () => {
    render(<GithubCard url="https://github.com/octo/repo/issues/7" />)
    const link = screen.getByRole('link', { name: /octo\/repo#7/ })
    // still a link to read and long-press
    expect(link.getAttribute('href')).toBe('https://github.com/octo/repo/issues/7')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    await settle()
    expect(env.opened).toEqual(['https://github.com/octo/repo/issues/7'])
  })
})

describe('a backup’s Open', () => {
  it('opens its download link in Safari’s sheet', async () => {
    const noop = () => {}
    render(
      <SnapshotFiles
        users={[{ userId: 'u', email: 'owner@example.com', bytes: 1, files: [{ name: '2026-09-23.json', path: 'backups/u/2026-09-23.json', date: '2026-09-23', size: 1, updatedAt: null }] }]}
        busy={false}
        pending=""
        opened={null}
        link={{ path: 'backups/u/2026-09-23.json', url: 'https://example.supabase.co/storage/v1/object/sign/media/backups/u/2026-09-23.json?token=t' }}
        passphrase=""
        onPassphrase={noop}
        onRead={noop}
        onDownload={noop}
        onUnlock={noop}
        onSave={noop}
        onClose={noop}
      />,
    )
    fireEvent.click(screen.getByRole('link', { name: 'Open' }))
    await settle()
    expect(env.opened).toEqual(['https://example.supabase.co/storage/v1/object/sign/media/backups/u/2026-09-23.json?token=t'])
  })
})
