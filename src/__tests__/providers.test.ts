import { describe, expect, it } from 'vitest'
import { googleEntryBody, googleEntryPlan } from '../../netlify/functions/lib/google.mjs'
import { graphEntryBody, graphEntryPlan } from '../../netlify/functions/lib/microsoft.mjs'

// The provider libraries talk to live Google and Microsoft accounts, which
// nothing here can reach. What CAN be proven offline is the part that decides
// what to send and what to do about what the provider already holds — which is
// where the subtle bugs live (Undo, busy vs free, and never being read back as
// a task).

const timed = {
  kind: 'event',
  id: 'ev1',
  title: 'Dentist',
  start: '2026-09-10T14:00:00.000Z',
  end: '2026-09-10T15:30:00.000Z',
  allDay: false,
  location: 'High Street',
  notes: 'Bring the form',
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
}
const allDay = { ...timed, id: 'ev2', allDay: true, start: '2026-09-12', end: '2026-09-15' }
const gone = { ...timed, deletedAt: '2026-09-11T00:00:00.000Z' }

describe('Google: what to do with what Google already holds', () => {
  it('creates when nothing is there', () => {
    expect(googleEntryPlan(null, timed)).toEqual({ op: 'create' })
  })
  it('updates the live copy in place', () => {
    expect(googleEntryPlan({ id: 'g1', status: 'confirmed' }, timed)).toEqual({ op: 'patch', id: 'g1' })
  })
  it('deletes the live copy when the entry is deleted', () => {
    expect(googleEntryPlan({ id: 'g1', status: 'confirmed' }, gone)).toEqual({ op: 'delete', id: 'g1' })
  })
  it('has nothing to delete when only a cancelled copy remains', () => {
    expect(googleEntryPlan({ id: 'g1', status: 'cancelled' }, gone)).toEqual({ op: 'skip' })
    expect(googleEntryPlan(null, gone)).toEqual({ op: 'skip' })
  })
  it('leaves an event the user deleted in Google deleted', () => {
    expect(googleEntryPlan({ id: 'g1', status: 'cancelled' }, timed)).toEqual({ op: 'skip' })
  })
  it('but Drafter Undo revives it — our own DELETE is what cancelled it', () => {
    expect(googleEntryPlan({ id: 'g1', status: 'cancelled' }, timed, { revive: true })).toEqual({ op: 'create' })
  })
})

describe('Google: the event body', () => {
  it('marks a timed entry busy with its real range', () => {
    const b = googleEntryBody(timed, 'https://drafterz.netlify.app')
    expect(b.transparency).toBe('opaque')
    expect(b.start).toEqual({ dateTime: '2026-09-10T14:00:00.000Z' })
    expect(b.end).toEqual({ dateTime: '2026-09-10T15:30:00.000Z' })
    expect(b.location).toBe('High Street')
    expect(b.description).toContain('Bring the form')
  })
  it('passes an all-day entry through as dates with its exclusive end', () => {
    const b = googleEntryBody(allDay, '')
    expect(b.start).toEqual({ date: '2026-09-12' })
    expect(b.end).toEqual({ date: '2026-09-15' })
  })
  it('is keyed on eventId and never taskId, so the pull cannot read it as a task', () => {
    const p = googleEntryBody(timed, '').extendedProperties.private
    expect(p.eventId).toBe('ev1')
    expect(p).not.toHaveProperty('taskId')
  })
  it('falls back to a title rather than sending an empty one', () => {
    expect(googleEntryBody({ ...timed, title: '' }, '').summary).toBe('Untitled event')
  })
})

describe('Microsoft: what to do with what the account already holds', () => {
  it('creates, updates, deletes and skips', () => {
    expect(graphEntryPlan(null, timed)).toEqual({ op: 'create' })
    expect(graphEntryPlan({ id: 'm1' }, timed)).toEqual({ op: 'patch', id: 'm1' })
    expect(graphEntryPlan({ id: 'm1' }, gone)).toEqual({ op: 'delete', id: 'm1' })
    expect(graphEntryPlan(null, gone)).toEqual({ op: 'skip' })
  })
  it('needs no revive: Graph hard-deletes, so an Undo simply finds nothing and creates', () => {
    expect(graphEntryPlan(null, timed)).toEqual({ op: 'create' })
  })
})

describe('Microsoft: the event body', () => {
  it('marks a timed entry busy in UTC without milliseconds', () => {
    const b = graphEntryBody(timed, '')
    expect(b.showAs).toBe('busy')
    expect(b.isAllDay).toBe(false)
    expect(b.start).toEqual({ dateTime: '2026-09-10T14:00:00', timeZone: 'UTC' })
    expect(b.end).toEqual({ dateTime: '2026-09-10T15:30:00', timeZone: 'UTC' })
    expect(b.location).toEqual({ displayName: 'High Street' })
  })
  it('sends all-day as midnight to an exclusive midnight', () => {
    const b = graphEntryBody(allDay, '')
    expect(b.isAllDay).toBe(true)
    expect(b.start).toEqual({ dateTime: '2026-09-12T00:00:00', timeZone: 'UTC' })
    expect(b.end).toEqual({ dateTime: '2026-09-15T00:00:00', timeZone: 'UTC' })
  })
  it('is keyed on its own event property, never the task one the pull reads', () => {
    const [prop] = graphEntryBody(timed, '').singleValueExtendedProperties
    expect(prop.value).toBe('ev1')
    expect(prop.id).toContain('drafterEventId')
    expect(prop.id).not.toContain('drafterTaskId')
  })
  it('omits a location rather than sending an empty one', () => {
    expect(graphEntryBody({ ...timed, location: undefined }, '').location).toBeUndefined()
  })
})

describe('parity: both providers treat an entry the same way', () => {
  it('both show it as busy time, not free', () => {
    expect(googleEntryBody(timed, '').transparency).toBe('opaque')
    expect(graphEntryBody(timed, '').showAs).toBe('busy')
  })
  it('both put the same instants on the calendar', () => {
    const g = googleEntryBody(timed, '')
    const m = graphEntryBody(timed, '')
    expect(Date.parse(g.start.dateTime!)).toBe(Date.parse(`${m.start.dateTime}Z`))
    expect(Date.parse(g.end.dateTime!)).toBe(Date.parse(`${m.end.dateTime}Z`))
  })
})
