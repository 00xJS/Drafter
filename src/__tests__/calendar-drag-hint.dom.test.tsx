// @vitest-environment happy-dom
import { render } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Calendar, calendarHint, dragsHere, type CalendarView } from '../components/Calendar'

// The calendar's hint says a pill or a task can be dragged to another day.
// In the app on an iPhone there is no drag to make, so the hint promised
// something that never came. It says what a tap does there, and keeps the
// drag where there is one: every browser, and an iPad's shell.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
// an iPad's web view asks for the desktop site, and says it is a Mac
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const noop = () => {}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 10, 9))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('native')
})

/** As a device: the app's shell or a browser, on this user agent. */
function as(shell: boolean, userAgent: string) {
  document.documentElement.classList.toggle('native', shell)
  vi.stubGlobal('navigator', { ...navigator, userAgent })
}

const hint = (view: CalendarView) => {
  const { container } = render(
    <Calendar
      view={view}
      tasks={[]}
      projects={[]}
      projectMap={new Map()}
      people={[]}
      meals={[]}
      recipes={[]}
      places={[]}
      events={[]}
      sourceMap={new Map()}
      onOpen={noop}
      onNew={noop}
      onSaveMeal={noop}
      onClearMeal={noop}
      onCreatePlace={() => {
        throw new Error('not here')
      }}
      onCreateRecipe={() => {
        throw new Error('not here')
      }}
      onNewEvent={noop}
      onEditEvent={noop}
      onReschedule={noop}
      onPlan={noop}
      onAttendance={noop}
      onOpenProject={noop}
      onPlanOccasion={noop}
    />,
  )
  return container.querySelector('.cal-hint')?.textContent ?? ''
}

describe('the calendar’s hint', () => {
  it('in the app on an iPhone: what a tap does, and no drag', () => {
    as(true, IPHONE)
    expect(dragsHere()).toBe(false)
    expect(hint('month')).toBe('Tap a day to expand it')
    expect(hint('week')).toBe('Tap a day header for everything on it')
  })

  it('in a browser, and in the app on an iPad: the drag as well', () => {
    as(false, IPHONE)
    expect(dragsHere()).toBe(true)
    expect(hint('month')).toBe('Tap a day to expand it · drag a pill to move its due date')
    as(true, IPAD)
    expect(dragsHere()).toBe(true)
    expect(hint('week')).toBe('Tap a day header for everything on it · drag a task to move its due date')
  })

  it('says the same on the Day tab wherever it is', () => {
    expect(calendarHint('day', false)).toBe(calendarHint('day', true))
  })
})
