// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Where a view that fails to draw ends up: the pushed screen named as itself
// and cleared when it goes, its ‹ Back still there; one Home card failing on
// its own; the top bar and the toast each failing without the app; and the
// root, where nothing else caught it. Each is reported under its own name.

vi.mock('../errorreport', () => ({ reportRenderError: vi.fn() }))

import { AppBoundary, CardBoundary, ErrorBoundary } from '../components/ErrorBoundary'
import { PushedScreen } from '../components/planner/PushedScreen'
import { ScreenBoundary } from '../components/planner/ScreenBoundary'
import { ToastHost } from '../components/planner/Toast'
import { TopBarCrash } from '../components/planner/TopBar'
import { createToaster } from '../components/planner/useToast'
import { reportRenderError } from '../errorreport'

/** A view that throws as it draws while `broken`. */
function Boom({ broken = true, text = 'drawn' }: { broken?: boolean; text?: string }) {
  if (broken) throw new Error('Cannot read properties of undefined')
  return <p>{text}</p>
}

const reported = () => vi.mocked(reportRenderError).mock.calls.map(([, where]) => where)

beforeEach(() => {
  // React says so on the console for every error a boundary catches
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(reportRenderError).mockClear()
})

describe('the screen on show', () => {
  it('names a pushed screen that fails as itself, and clears when it goes, the same tab under it', () => {
    const view = render(
      <ScreenBoundary view="home" pushed="settings">
        <Boom />
      </ScreenBoundary>,
    )
    expect(screen.getByRole('heading').textContent).toBe('Something broke in Settings')
    expect(reported()).toEqual(['Settings'])
    // back to Home, which was the tab all along
    view.rerender(
      <ScreenBoundary view="home" pushed={null}>
        <Boom broken={false} text="Home" />
      </ScreenBoundary>,
    )
    expect(screen.getByText('Home')).toBeTruthy()
  })

  it('names a tab that fails as the tab, and clears when another is chosen', () => {
    const view = render(
      <ScreenBoundary view="tasks" pushed={null}>
        <Boom />
      </ScreenBoundary>,
    )
    expect(screen.getByRole('heading').textContent).toBe('Something broke in Tasks')
    view.rerender(
      <ScreenBoundary view="calendar" pushed={null}>
        <Boom broken={false} text="Calendar" />
      </ScreenBoundary>,
    )
    expect(screen.getByText('Calendar')).toBeTruthy()
  })

  it('keeps a pushed screen’s ‹ Back on screen when its body fails, and Back leaves', () => {
    const back = vi.fn()
    render(
      <PushedScreen title="Settings" onBack={back}>
        <Boom />
      </PushedScreen>,
    )
    expect(screen.getByRole('heading', { name: 'Something broke in Settings' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(back).toHaveBeenCalledTimes(1)
  })
})

describe('Home’s cards', () => {
  it('leaves the rest of the day up when one card fails, and says so in its place', () => {
    render(
      <>
        <CardBoundary name="the briefing">
          <Boom broken={false} text="Sunny, 31°" />
        </CardBoundary>
        <CardBoundary name="the habits">
          <Boom />
        </CardBoundary>
        <CardBoundary name="the routines">
          <Boom broken={false} text="Morning routine" />
        </CardBoundary>
      </>,
    )
    expect(screen.getByText('Sunny, 31°')).toBeTruthy()
    expect(screen.getByText('Morning routine')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Something broke in the habits')
    expect(reported()).toEqual(['the habits'])
  })
})

describe('the bars around the screens', () => {
  it('draws the top bar’s stand-in when it fails, and Try again draws it again', () => {
    let broken = true
    function Bar() {
      return <Boom broken={broken} text="Drafter" />
    }
    render(
      <ErrorBoundary where="the top bar" fallback={(_, retry) => <TopBarCrash retry={retry} />}>
        <Bar />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toContain('The top bar hit a problem')
    expect(reported()).toEqual(['the top bar'])
    broken = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Drafter')).toBeTruthy()
  })

  it('leaves out a toast that fails to draw, and draws the next one', () => {
    const toaster = createToaster()
    render(<ToastHost toaster={toaster} />)
    // not a line of text: React cannot draw it
    act(() => toaster.show({ not: 'a message' } as unknown as string))
    expect(screen.queryByRole('status')).toBeNull()
    // (React draws an update that failed once more before it gives up on it, so it may be heard twice)
    expect([...new Set(reported())]).toEqual(['the toast'])
    act(() => toaster.show('Saved'))
    expect(screen.getByRole('status').textContent).toContain('Saved')
  })
})

describe('the root', () => {
  it('ends on a plain page with Reload, never a blank one, and reports it', () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    render(
      <AppBoundary>
        <Boom />
      </AppBoundary>,
    )
    expect(screen.getByRole('heading').textContent).toBe('Something went wrong')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reported()).toEqual(['the app'])
  })
})
