import { describe, expect, it } from 'vitest'
import { editedSinceCancelled, googleEntryBody, googleEntryPlan, googleTaskBody, newestCopy } from '../../netlify/functions/lib/google.mjs'
import { graphEntryBody, graphEntryPlan, graphTaskBody } from '../../netlify/functions/lib/microsoft.mjs'

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

// The owner decided that Drafter alone sends reminders (1E's recommendation).
// Google copies of tasks used to pop up 30 minutes ahead, or at 3pm the day
// before an all-day one; Outlook copies, and events mirrored to Google, rang
// with each calendar's own default. Now every copy is silent unless the owner
// turns on "Calendar copies remind me too", which brings each calendar's own back.
describe('Drafter alone reminds: the copies carry no reminder of their own', () => {
  const timedTask = { kind: 'task', id: 't1', title: 'Pay rent', description: '', status: 'todo', priority: 'normal', dueAt: '2026-09-10T14:00:00.000Z' }
  // local midnight in London: an all-day copy
  const dayTask = { ...timedTask, id: 't2', dueAt: '2026-09-09T23:00:00.000Z' }
  const silent = { useDefault: false, overrides: [] }
  const theirs = { useDefault: true, overrides: [] }

  it('Google: a task copy, timed or all-day, rings no popup and takes no default', () => {
    expect(googleTaskBody(timedTask, undefined, '', 'Europe/London').reminders).toEqual(silent)
    const day = googleTaskBody(dayTask, undefined, '', 'Europe/London')
    expect(day.start).toEqual({ date: '2026-09-10' })
    expect(day.reminders).toEqual(silent)
  })

  it('Google: an event copy no longer takes the calendar’s defaults, a work day neither', () => {
    expect(googleEntryBody(timed, '').reminders).toEqual(silent)
    expect(googleEntryBody(allDay, '').reminders).toEqual(silent)
    expect(googleEntryBody({ ...timed, work: 'office' }, '').reminders).toEqual(silent)
  })

  it('Outlook: every copy has its reminder off', () => {
    expect(graphTaskBody(timedTask, undefined, '', 'Europe/London').isReminderOn).toBe(false)
    expect(graphTaskBody(dayTask, undefined, '', 'Europe/London').isReminderOn).toBe(false)
    expect(graphEntryBody(timed, '').isReminderOn).toBe(false)
    expect(graphEntryBody({ ...allDay, work: 'home' }, '').isReminderOn).toBe(false)
  })

  it('with “Calendar copies remind me too” on, each calendar’s own reminders come back', () => {
    expect(googleTaskBody(timedTask, undefined, '', 'Europe/London', true).reminders).toEqual(theirs)
    expect(googleEntryBody(timed, '', { remind: true }).reminders).toEqual(theirs)
    expect(graphTaskBody(timedTask, undefined, '', 'Europe/London', true).isReminderOn).toBe(true)
    expect(graphEntryBody(timed, '', { remind: true }).isReminderOn).toBe(true)
  })

  it('an old copy’s 30-minute popup is cleared, not left in place by the PATCH that corrects it', () => {
    // a PATCH replaces a list it names and keeps one it leaves out
    for (const b of [googleTaskBody(timedTask, undefined, '', null), googleTaskBody(timedTask, undefined, '', null, true), googleEntryBody(timed, '')]) {
      expect(b.reminders.overrides).toEqual([])
    }
  })
})

describe('Google: the newer write wins over a cancelled copy', () => {
  it('revives an entry edited after its Google copy was cancelled (a restore, a re-save)', () => {
    const cancelled = { id: 'g1', status: 'cancelled', updated: '2026-09-10T10:00:00.000Z' }
    expect(googleEntryPlan(cancelled, { ...timed, updatedAt: '2026-09-10T11:00:00.000Z' })).toEqual({ op: 'create' })
  })

  it('leaves it gone when the owner deleted it in Google after the last Drafter edit', () => {
    const cancelled = { id: 'g1', status: 'cancelled', updated: '2026-09-10T12:00:00.000Z' }
    expect(googleEntryPlan(cancelled, { ...timed, updatedAt: '2026-09-10T11:00:00.000Z' })).toEqual({ op: 'skip' })
  })

  it('editedSinceCancelled is only ever true for a cancelled copy older than the record', () => {
    expect(editedSinceCancelled({ id: 'a', status: 'confirmed', updated: '2026-01-01T00:00:00Z' }, { updatedAt: '2026-06-01T00:00:00Z' })).toBe(false)
    expect(editedSinceCancelled({ id: 'a', status: 'cancelled', updated: '2026-06-01T00:00:00Z' }, { updatedAt: '2026-01-01T00:00:00Z' })).toBe(false)
    expect(editedSinceCancelled({ id: 'a', status: 'cancelled', updated: '2026-01-01T00:00:00Z' }, { updatedAt: '2026-06-01T00:00:00Z' })).toBe(true)
    expect(editedSinceCancelled(null, { updatedAt: '2026-06-01T00:00:00Z' })).toBe(false)
  })

  it('newestCopy prefers the live event, else the most recently cancelled one', () => {
    expect(newestCopy([{ id: 'a', status: 'cancelled', updated: '2026-01-02T00:00:00Z' }, { id: 'b', status: 'confirmed' }])?.id).toBe('b')
    expect(
      newestCopy([
        { id: 'old', status: 'cancelled', updated: '2026-01-01T00:00:00Z' },
        { id: 'new', status: 'cancelled', updated: '2026-01-03T00:00:00Z' },
      ])?.id,
    ).toBe('new')
    expect(newestCopy([])).toBeNull()
    expect(newestCopy(undefined)).toBeNull()
  })
})
