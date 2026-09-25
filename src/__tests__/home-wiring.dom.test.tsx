// @vitest-environment happy-dom
import { render } from './dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { CalendarEntry, CalendarEvent } from '../types'

// Where Home's top section leads, as the shell hands it over: a day of the
// week strip to the Calendar on that day, the Dinner tile to the Kitchen's
// This week on today, Up next's event to its editor (or its day), This week
// so far to Insights → Stats on the week — and whether there is a household
// to say "Maria cooks" to.

vi.mock('../supabase', () => ({ getSupabase: () => null, storedUserId: () => null }))
vi.mock('../components/Today', () => ({ Today: vi.fn(() => null) }))

import { HomeScreen } from '../components/planner/HomeScreen'
import type { PlannerCtx } from '../components/planner/ctx'
import type { Store } from '../store'
import { Today } from '../components/Today'

const T0 = '2026-09-25T09:00:00.000Z'
const entry: CalendarEntry = { kind: 'event', id: 'dentist', title: 'Dentist', start: '2026-09-25T22:30:00.000Z', end: '2026-09-25T23:30:00.000Z', allDay: false, createdAt: T0, updatedAt: T0 }
const lists = { tasks: [], people: [], places: [], reviews: [], projects: [], meals: [], recipes: [], journal: [], habits: [], routines: [], events: [entry], garments: [], outfits: [], wears: [], snoozes: [], notices: [] }

type TodayProps = ComponentProps<typeof Today>

function shell(over: Record<string, unknown> = {}) {
  const calls = new Map<string, ReturnType<typeof vi.fn>>()
  const fn = (name: string) => {
    if (!calls.has(name)) calls.set(name, vi.fn())
    return calls.get(name)!
  }
  const kept: Record<string, unknown> = { household: { info: null, myId: 'me' }, allEvents: [], sourceMap: new Map(), syncAlarm: null, calendarSignIn: null, inHousehold: true, ...over }
  const p = new Proxy({ store: { ...lists, syncInfo: { lastAt: T0 } } as unknown as Store } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : key in kept ? kept[key] : fn(key)),
  }) as unknown as PlannerCtx
  render(<HomeScreen p={p} />)
  const props = vi.mocked(Today).mock.calls.at(-1)![0] as TodayProps
  return { props, calls: fn }
}

beforeEach(() => vi.mocked(Today).mockClear())

describe('Home’s top section, as the shell wires it', () => {
  it('knows there is a household', () => {
    expect(shell().props.inHousehold).toBe(true)
    expect(shell({ inHousehold: false }).props.inHousehold).toBe(false)
  })

  it('opens the Calendar on a day of the week strip', () => {
    const { props, calls } = shell()
    props.onOpenDay!('2026-09-23')
    expect(calls('openCalendarDay')).toHaveBeenCalledWith('2026-09-23')
  })

  it('opens the Kitchen’s This week on today from the Dinner tile', () => {
    const { props, calls } = shell()
    props.onOpenKitchenDay!('2026-09-25')
    expect(calls('openKitchenDay')).toHaveBeenCalledWith('2026-09-25')
  })

  it('opens an event of ours in its editor, and any other on its day in the Calendar', () => {
    const { props, calls } = shell()
    const ours: CalendarEvent = { id: 'dentist', sourceId: 'local', title: 'Dentist', start: entry.start, end: entry.end, allDay: false, localId: 'dentist' }
    props.onOpenEvent!(ours)
    expect(calls('setEventEditor')).toHaveBeenCalledWith({ entry, startIso: entry.start })
    const followed: CalendarEvent = { id: 'feed-1', sourceId: 'school', title: 'Assembly', start: new Date(2026, 8, 26, 9).toISOString(), end: new Date(2026, 8, 26, 10).toISOString(), allDay: false }
    props.onOpenEvent!(followed)
    expect(calls('openCalendarDay')).toHaveBeenCalledWith('2026-09-26')
  })

  it('opens Insights → Stats on the week from This week so far', () => {
    const { props, calls } = shell()
    props.onOpenInsightsWeek!()
    expect(calls('openInsights')).toHaveBeenCalledWith('week', null)
  })
})
