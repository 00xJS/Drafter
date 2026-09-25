// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from './dom'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// iOS takes an idle app's web content back — after the full-screen camera, or
// a while in the background — and Capacitor reloads the page into the same web
// view, which came back on Home whatever tab it had been on. In the shell the
// tab is now kept in sessionStorage, which a reload into the same web view
// keeps and a launch starts without, so a tab kept is itself the sign of a
// reload (src/reloadstate.ts). On the iOS 27 simulator, after the web content
// process was killed, WebKit named the new page's navigation "back_forward",
// not "reload", so the navigation entry is not asked. A reload asked for — the
// error screen's, a sign-out's — forgets the tab and opens on Home.

const env = vi.hoisted(() => ({ native: true, navigation: 'reload' as string }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') }, registerPlugin: () => ({}) }))

import { ErrorBoundary } from '../components/ErrorBoundary'
import { useNavigation } from '../components/planner/useNavigation'
import { RELOAD_VIEW_KEY } from '../reloadstate'

function Shell() {
  const { view, setView } = useNavigation()
  return (
    <>
      <p data-testid="view">{view}</p>
      {(['calendar', 'tasks'] as const).map(v => (
        <button key={v} onClick={() => setView(v)}>{`Go to ${v}`}</button>
      ))}
    </>
  )
}

const shown = () => screen.getByTestId('view').textContent
const go = (view: 'calendar' | 'tasks') => act(async () => void fireEvent.click(screen.getByRole('button', { name: `Go to ${view}` })))

beforeEach(() => {
  // every test starts as a launch does: nothing kept
  sessionStorage.clear()
  env.native = true
  env.navigation = 'reload'
  vi.spyOn(performance, 'getEntriesByType').mockImplementation(() => [{ type: env.navigation }] as unknown as PerformanceEntryList)
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** The planner starting on a page loaded this way, with what the last one kept. */
function start(navigation: string) {
  env.navigation = navigation
  return render(<Shell />)
}

describe('the tab comes back after iOS reclaims the page', () => {
  it('opens on the tab it was on when the web content comes back, as WebKit names that load', async () => {
    const first = start('navigate')
    expect(shown()).toBe('home')
    await go('calendar')
    expect(sessionStorage.getItem(RELOAD_VIEW_KEY)).toBe('calendar')
    first.unmount()
    // the web content was taken back; Capacitor reloads the page, and WebKit
    // calls that load back_forward (seen on the iOS 27 simulator), or reload
    const again = start('back_forward')
    expect(shown()).toBe('calendar')
    again.unmount()
    start('reload')
    expect(shown()).toBe('calendar')
  })

  it('opens on Home at a launch, which keeps no tab', () => {
    sessionStorage.removeItem(RELOAD_VIEW_KEY)
    start('navigate')
    expect(shown()).toBe('home')
  })

  it('reads nothing it does not know as a tab', () => {
    sessionStorage.setItem(RELOAD_VIEW_KEY, 'constructor')
    start('reload')
    expect(shown()).toBe('home')
  })

  it('in a browser, keeps nothing and restores nothing: a reload there is the reader’s own', async () => {
    env.native = false
    sessionStorage.setItem(RELOAD_VIEW_KEY, 'insights')
    start('reload')
    expect(shown()).toBe('home')
    await go('tasks')
    expect(sessionStorage.getItem(RELOAD_VIEW_KEY)).toBe('insights')
  })
})

describe('a reload asked for opens on Home', () => {
  function Broken(): never {
    throw new Error('the view broke')
  }

  it('the error screen’s Reload forgets the tab it broke on', () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      sessionStorage.setItem(RELOAD_VIEW_KEY, 'insights')
      render(
        <ErrorBoundary where="Insights">
          <Broken />
        </ErrorBoundary>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
      expect(reload).toHaveBeenCalledOnce()
      expect(sessionStorage.getItem(RELOAD_VIEW_KEY)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a sign-out forgets it, so the next account starts on Home', () => {
    const idb = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'idb.ts'), 'utf8')
    const clear = /export async function clearLocalData[\s\S]*?\n\}\n/.exec(idb)?.[0] ?? ''
    expect(clear).toMatch(/const \{ forgetView \} = await import\('\.\/reloadstate'\)\s*forgetView\(\)/)
    const boundary = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'ErrorBoundary.tsx'), 'utf8')
    // both Reload buttons, the screen's and the app's
    expect(boundary.match(/onClick=\{reloadAfresh\}/g)).toHaveLength(2)
    expect(boundary).not.toMatch(/onClick=\{\(\) => window\.location\.reload\(\)\}/)
  })
})
