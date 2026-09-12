import { describe, expect, it } from 'vitest'
import { pxPerDay, timelineRange } from '../components/Roadmap'
import { DAY_MS, startOfDay } from '../taskutils'
import type { Project, Task } from '../types'

// The Timeline runs from the first day of the service to today — not from a
// month before the oldest project to three months past today — and a young
// history stretches to fill the screen instead of being a 56px sliver.

const project = (createdAt: string): Project =>
  ({ kind: 'project', id: createdAt, name: 'P', color: '#888', status: 'active', createdAt, updatedAt: createdAt }) as Project
const task = (createdAt: string): Task =>
  ({ kind: 'task', id: createdAt, title: 't', description: '', status: 'todo', priority: 'normal', tags: [], createdAt, updatedAt: createdAt }) as Task

const today = startOfDay(new Date(2026, 8, 12, 15, 0))

describe('timelineRange', () => {
  it('starts on the day the account was created and ends at the end of today', () => {
    const { from, to } = timelineRange(new Date(2026, 7, 29, 14, 30).toISOString(), [project(new Date(2026, 8, 1).toISOString())], [], today)
    expect(from.getTime()).toBe(new Date(2026, 7, 29).getTime())
    expect(to.getTime()).toBe(today.getTime() + DAY_MS)
  })

  it('falls back to the earliest project or task when there is no account (local mode)', () => {
    const { from } = timelineRange(null, [project(new Date(2026, 8, 3).toISOString())], [task(new Date(2026, 8, 1, 9).toISOString())], today)
    expect(from.getTime()).toBe(new Date(2026, 8, 1).getTime())
  })

  it('never starts after today, and a history with nothing in it is just today', () => {
    expect(timelineRange(new Date(2027, 0, 1).toISOString(), [], [], today).from.getTime()).toBe(today.getTime())
    expect(timelineRange(null, [], [], today).from.getTime()).toBe(today.getTime())
  })
})

describe('pxPerDay', () => {
  it('stretches a short history to fill the width, up to a cap', () => {
    expect(pxPerDay(700, 14)).toBe(48)
    expect(pxPerDay(700, 20)).toBe(35)
  })

  it('packs a long history down to the minimum and lets it scroll', () => {
    expect(pxPerDay(700, 400)).toBe(4)
  })

  it('falls back to the minimum before the width is known', () => {
    expect(pxPerDay(0, 14)).toBe(4)
    expect(pxPerDay(-100, 14)).toBe(4)
  })
})
