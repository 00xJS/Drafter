// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Calendar } from '../components/Calendar'

// The calendar's day sheet on a phone: its rows alone scrolled, and Eating —
// most of a phone screen once a dinner has sides — stood under them outside
// the scroller at its full height. The rows were left a 12pt strip, none of
// them readable, and on a small phone the footer's New task and New event
// were pushed below the screen. The rows and Eating scroll as one now, between
// a header and a footer that keep their size.

const noop = () => {}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 10, 9))
})
afterEach(() => {
  vi.useRealTimers()
})

/** The calendar's own sheet (styles/views/calendar.css), comments out: from the working folder, as a document's tests read files. */
const calendarCss = readFileSync(join(process.cwd(), 'src/styles/views/calendar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
/** The rule for exactly `selector` in it. */
const rule = (selector: string) => new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(calendarCss)?.[1] ?? ''

describe('the day sheet', () => {
  it('scrolls the day’s rows and its Eating as one, with the footer outside the scroller', () => {
    render(
      <Calendar
        view="month"
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
    fireEvent.click(document.querySelector('.cal-cell.today') as HTMLElement)
    const sheet = screen.getByRole('dialog')
    const scroller = sheet.querySelector(':scope > .cal-sheet-scroll') as HTMLElement
    expect(scroller).toBeTruthy()
    expect(scroller.querySelector(':scope > .cal-sheet-body')).toBeTruthy()
    expect(scroller.querySelector(':scope > .cal-sheet-eating')).toBeTruthy()
    // the header over it and the footer under it are the sheet's own
    expect([...sheet.children].map(c => c.className)).toEqual(['cal-sheet-head', 'cal-sheet-scroll', 'cal-sheet-foot'])
  })

  it('makes that one box the scroller, and keeps the header and footer their size', () => {
    const scroll = rule('.cal-sheet-scroll')
    expect(scroll).toMatch(/overflow-y:\s*auto/)
    expect(scroll).toMatch(/min-height:\s*0/)
    expect(rule('.cal-sheet-head,\n.cal-sheet-foot')).toMatch(/flex:\s*none/)
    // the Day tab draws the same face on the page, which scrolls it there
    expect(rule('.cal-day .cal-sheet-body,\n.cal-day .cal-sheet-scroll')).toMatch(/overflow:\s*visible/)
  })
})
