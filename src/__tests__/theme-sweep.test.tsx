import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Calendar } from '../components/Calendar'
import { MoodChart } from '../components/Journal'
import { Bars } from '../components/People'
import { Places } from '../components/Places'
import { Roadmap } from '../components/Roadmap'
import { graphicInk, heatStyle, readableInk } from '../contrast'
import type { CalendarEvent, CalendarSource, Place, Project, Recipe, Task } from '../types'

// The call sites of the theme sweep. A colour the stylesheet cannot know (a
// project's, a feed's, a place's) is drawn through the contrast helpers, and
// the calendar's own colours are tokens. A static render is the light theme
// (useTheme's server snapshot), so these pin the light wiring; contrast.test.ts
// covers dark, where every palette colour comes back as it was.

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const text = (html: string) => html.replace(/<!-- -->/g, '')
/** A day in September 2026, local time. */
const sept = (day: number, h = 13) => new Date(2026, 8, day, h).toISOString()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 12, 9))
})
afterEach(() => vi.useRealTimers())

describe('the month grid writes user colours so they read on the light ground', () => {
  const amber: Project = { kind: 'project', id: 'p', name: 'LIFE', color: '#fbbf24', status: 'active', createdAt: STAMP, updatedAt: STAMP }
  const task = (id: string, day: number, projectId?: string): Task => ({ kind: 'task', id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', tags: [], projectId, dueAt: sept(day, 9), createdAt: STAMP, updatedAt: STAMP })
  // Google's palest calendar colour
  const family: CalendarSource = { kind: 'calendar', id: 'family', name: 'Family', url: 'https://example.com/family.ics', color: '#fad165', enabled: true, createdAt: STAMP, updatedAt: STAMP }
  const event = (id: string, sourceId: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, sourceId, title: `Event ${id}`, start: sept(16), end: sept(16, 14), allDay: false, ...over })

  const month = () =>
    text(
      renderToStaticMarkup(
        <Calendar
          view="month"
          tasks={[task('mine', 15, 'p'), task('loose', 17)]}
          projects={[amber]}
          projectMap={new Map([['p', amber]])}
          people={[]}
          meals={[]}
          recipes={[]}
          places={[]}
          events={[event('feed', 'family'), event('gone', 'deleted-calendar'), event('ours', 'family', { localId: 'entry-1' })]}
          sourceMap={new Map([['family', family]])}
          onOpen={noop}
          onNew={noop}
          onSaveMeal={noop}
          onClearMeal={noop}
          onCreatePlace={() => ({}) as Place}
          onCreateRecipe={() => ({}) as Recipe}
          onNewEvent={noop}
          onEditEvent={noop}
          onReschedule={noop}
          onPlan={noop}
          onAttendance={noop}
          onOpenProject={noop}
          onPlanOccasion={noop}
        />,
      ),
    )

  it('keeps a project’s tint and moves its text only as far as it takes to read on it', () => {
    const ink = readableInk('#fbbf24', 'light', { tint: true })
    expect(ink).not.toBe('#fbbf24')
    expect(month()).toContain(`style="background:#fbbf2422;color:${ink}"`)
  })

  it('outlines a feed’s event in its own colour and writes its title readably', () => {
    const ink = readableInk('#fad165', 'light')
    expect(ink).not.toBe('#fad165')
    expect(month()).toContain(`style="border-color:#fad165;color:${ink}"`)
  })

  it('draws the calendar’s own colours and a task’s status as tokens', () => {
    const html = month()
    expect(html).toContain('style="border-color:var(--cal-event-local);color:var(--cal-event-local)"')
    expect(html).toContain('style="border-color:var(--dot-fallback);color:var(--dot-fallback)"')
    expect(html).toContain('style="background:var(--tone-amber-bg);color:var(--tone-amber)"')
  })
})

describe('a user colour drawn as a mark is deepened just enough to stand out on white', () => {
  const amber = '#fbbf24'

  it('the weekly bars: the colour made to stand out on the open row, and a zero week a stub the sheet dims per theme', () => {
    const fill = graphicInk(amber, 'light', { ground: 'raised' })
    expect(fill).not.toBe(amber)
    const html = renderToStaticMarkup(<Bars weekly={[0, 2, 1]} color={amber} />)
    expect(html).toContain('class="person-bar zero" style="height:8%"')
    expect(html).toContain(`class="person-bar" style="height:100%;background:${fill}"`)
    expect(html).not.toContain('opacity')
  })

  it('a Timeline span and a milestone’s edge', () => {
    const project: Project = { kind: 'project', id: 'p', name: 'LIFE', color: amber, status: 'active', milestones: [{ id: 'm', name: 'Launch', dueAt: sept(10) }], createdAt: STAMP, updatedAt: STAMP }
    const html = renderToStaticMarkup(<Roadmap projects={[project]} tasks={[]} events={[]} sourceMap={new Map()} onOpenProject={noop} onOpenTask={noop} />)
    const ink = graphicInk(amber, 'light')
    expect(ink).not.toBe(amber)
    expect(html).toMatch(new RegExp(`class="rm-bar inferred" style="[^"]*background:${ink}"`))
    expect(html).toMatch(new RegExp(`class="rm-ms" style="[^"]*border-color:${ink}"`))
  })

  it('the mood columns carry their mood for the sheet to set their strength, not an opacity of their own', () => {
    const series = { days: [{ date: '2026-09-10', mood: 1 as const }, { date: '2026-09-11', mood: 5 as const }, { date: '2026-09-12' }], weekly: [] }
    const html = renderToStaticMarkup(<MoodChart series={series} summary="Moods" />)
    expect(html).toMatch(/class="mood-col"[^>]*style="--mood:1"/)
    expect(html).toMatch(/class="mood-col"[^>]*style="--mood:5"/)
    expect(html).not.toMatch(/class="mood-col"[^>]*opacity/)
  })
})

describe('the year in places gives a deep colour’s busiest cells their own ink', () => {
  // off the palette: the default an assistant gives a project, too deep for the dark text
  const indigo: Place = { kind: 'place', id: 'indigo', name: 'Indigo', color: '#4f46e5', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP }
  const outing = (id: string, month: number, day: number): Task => ({
    kind: 'task',
    id,
    title: 'Dinner at Indigo',
    description: '',
    status: 'done',
    priority: 'normal',
    tags: ['visit'],
    placeId: 'indigo',
    completedAt: new Date(2026, month, day, 20).toISOString(),
    createdAt: STAMP,
    updatedAt: STAMP,
  })
  // one outing in July, four in August
  const tasks = [outing('jul', 6, 4), ...[3, 10, 17, 24].map(d => outing(`aug-${d}`, 7, d))]
  const table = () => {
    const html = renderToStaticMarkup(<Places places={[indigo]} people={[]} tasks={tasks} meals={[]} onSave={noop} onDelete={noop} onLogOuting={noop} onPlan={noop} onOpenTask={noop} />)
    return html.slice(html.indexOf('class="year-table"'))
  }
  const css = (s: { background: string; color?: string }) => `background:${s.background}${s.color ? `;color:${s.color}` : ''}`

  it('keeps the page’s text on a light cell and puts white on the deepest', () => {
    const july = heatStyle('#4f46e5', 1, 'light')
    const august = heatStyle('#4f46e5', 4, 'light')
    expect(july.color).toBeUndefined()
    expect(august.color).toBe('var(--on-deep-user-color)')
    expect(table()).toContain(`title="1 outing" style="${css(july)}"`)
    expect(table()).toContain(`title="4 outings" style="${css(august)}"`)
  })
})
