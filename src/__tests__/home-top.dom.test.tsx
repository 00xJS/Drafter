// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeTiles, HomeWeekStrip } from '../components/home/HomeWeek'
import { WeekSoFar } from '../components/home/WeekSoFar'
import { Highlights } from '../components/insights/Highlights'
import { tonight, upNext, weekStrip } from '../homeweek'
import { insightFigures, periodSpan, pickHighlights, type InsightInput } from '../../shared/insights.mts'
import { localDayKey } from '../../shared/journal.mts'
import type { CalendarEvent, Meal, Recipe, Task } from '../types'

// Home's top section below the week's 3: the week strip, Dinner and Up next,
// and This week so far — each a way somewhere, and the last counted by
// Insights' own rules, the same first card Insights → Stats draws on Week.

const TODAY = '2026-09-25'
const STAMP = '2026-09-01T00:00:00.000Z'
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m).toISOString()
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })
const noop = () => {}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 25, 11, 32))
})
afterEach(() => vi.useRealTimers())

describe('the week strip', () => {
  const days = () => weekStrip(TODAY, [task('bins', { dueAt: at(21, 9) })], [], [{ id: 'dentist', sourceId: 's', title: 'Dentist', start: at(23, 15), end: at(23, 16), allDay: false }])

  it('is seven days, today marked, each named with what is on it', () => {
    render(<HomeWeekStrip days={days()} todayKey={TODAY} onOpenDay={noop} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(7)
    const today = screen.getByRole('button', { current: 'date' })
    expect(today.getAttribute('aria-label')).toBe('Today, Friday, September 25: nothing on')
    expect(screen.getByRole('button', { name: 'Monday, September 21: 1 task due' })).toBeTruthy()
    // a dot in the tasks' colour under Monday, the calendar's under Wednesday
    expect(screen.getByRole('button', { name: 'Monday, September 21: 1 task due' }).querySelector('.home-week-dots > i.ink-tasks')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Wednesday, September 23: 1 event' }).querySelector('.home-week-dots > i.home-dot-event')).toBeTruthy()
  })

  it('opens the Calendar on the day tapped', () => {
    const open = vi.fn()
    render(<HomeWeekStrip days={days()} todayKey={TODAY} onOpenDay={open} />)
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday, September 23: 1 event' }))
    expect(open).toHaveBeenCalledWith('2026-09-23')
  })
})

describe('Dinner and Up next', () => {
  const recipes: Recipe[] = [{ kind: 'recipe', id: 'tacos', name: 'Tacos', emoji: '🌮', ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP }]
  const tacos: Meal = { kind: 'meal', id: 'm1', date: TODAY, slot: 'dinner', title: 'Tacos', recipeId: 'tacos', createdAt: STAMP, updatedAt: STAMP }
  const dentist: CalendarEvent = { id: 'dentist', sourceId: 's', title: 'Dentist', start: at(25, 15, 30), end: at(25, 16, 30), allDay: false }

  it('says tonight’s dinner and who it is for, and opens This week', () => {
    const dinner = vi.fn()
    render(<HomeTiles tonight={tonight([tacos], recipes, TODAY, null)} who="Maria cooks" next={null} onOpenDinner={dinner} />)
    const tile = screen.getByRole('button', { name: /^Dinner/ })
    expect(tile.textContent).toBe('🌮DinnerTacosMaria cooks')
    fireEvent.click(tile)
    expect(dinner).toHaveBeenCalledTimes(1)
  })

  it('asks to plan dinner when there is none', () => {
    render(<HomeTiles tonight={null} who="" next={null} />)
    expect(screen.getByText('Plan dinner')).toBeTruthy()
    expect(screen.getByText('Nothing planned yet')).toBeTruthy()
  })

  it('names what is up next with its time, tomorrow’s said so, and opens it', () => {
    const open = vi.fn()
    const next = upNext({ events: [dentist], tasks: [], now: new Date(), todayKey: TODAY })
    const view = render(<HomeTiles tonight={null} who="" next={next} onOpenNext={open} />)
    const tile = screen.getByRole('button', { name: /^Up next/ })
    expect(tile.textContent).toContain('Dentist')
    expect(tile.textContent).toContain('3:30')
    fireEvent.click(tile)
    expect(open).toHaveBeenCalledTimes(1)
    view.rerender(<HomeTiles tonight={null} who="" next={{ ...next!, tomorrow: true }} onOpenNext={open} />)
    expect(screen.getByRole('button', { name: /^Up next/ }).textContent).toMatch(/Tomorrow · 3:30/)
  })
})

describe('This week so far', () => {
  const localDayOf = (iso: string) => localDayKey(new Date(iso))
  const done = (id: string, d: number) => task(id, { status: 'done', completedAt: at(d, 10), updatedAt: at(d, 10) })
  const lists = { tasks: [done('a', 21), done('b', 22), done('c', 22), done('d', 24), done('e', 14)], events: [], people: [], places: [], meals: [], recipes: [], journal: [], habits: [], garments: [], wears: [], myId: null }

  it('draws the week’s first highlight — the card Insights → Stats draws first on Week — and opens it', () => {
    const open = vi.fn()
    render(<WeekSoFar {...lists} household={false} onOpen={open} />)
    const input: InsightInput = { ...lists, now: new Date(), today: TODAY, dayKeyOf: localDayOf }
    const first = pickHighlights(insightFigures(input, periodSpan('week', TODAY, TODAY)))[0]
    expect(first.title).toBe('4 tasks done this week')
    const card = screen.getByRole('button', { name: `This week so far: ${first.line}. Open Insights` })
    expect(card.textContent).toContain('4 tasks done this week')
    expect(card.textContent).toContain('↑3')
    // the Insights page itself, on the same records, leads with the same line
    const insights = render(<Highlights input={input} household={false} period="week" onPeriod={noop} at={null} onAt={noop} onOpen={noop} />)
    const lead = insights.container.querySelector('.highlight-list > li:first-child .highlight-title')
    expect(lead?.textContent).toBe(first.title)
    fireEvent.click(card)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('draws nothing in a week with nothing to say', () => {
    const { container } = render(<WeekSoFar {...lists} tasks={[done('old', 7)]} household={false} onOpen={noop} />)
    expect(container.innerHTML).toBe('')
  })
})
