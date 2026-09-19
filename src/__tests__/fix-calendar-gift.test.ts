import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { plannedGift } from '../people'
import { Task } from '../types'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const calendar = read('../components/Calendar.tsx')
const today = read('../components/Today.tsx')
const screen = read('../components/planner/CalendarScreen.tsx')

// the sheet holds the occasion's day at local midnight; the gift was planned
// for the weekend before
const birthday = new Date(2026, 9, 3)
const gift: Task = {
  kind: 'task',
  id: 'g',
  title: 'Present for Sam',
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  tags: ['gift', 'birthday'],
  peopleIds: ['sam'],
  dueAt: new Date(2026, 8, 27, 9).toISOString(),
}

describe("the calendar's day sheet knows a gift is already planned", () => {
  it('asks the rule Today asks, rather than keeping a copy of it', () => {
    const fromPeople = /import \{[^}]*\bplannedGift\b[^}]*\} from '\.\.\/people'/
    expect(calendar).toMatch(fromPeople)
    expect(today).toMatch(fromPeople)
    // no second reading of the gift tags inside the component
    expect(calendar).not.toMatch(/includes\('gift'\)/)
  })

  it('opens the planned gift instead of offering a second one', () => {
    // the day sheet's occasion row (itemMeta above it also branches on 'occasion')
    const start = calendar.indexOf('const { person, kind } = item.occasion')
    expect(start).toBeGreaterThan(-1)
    const row = calendar.slice(start, calendar.indexOf("if (item.kind === 'event')", start))
    expect(row).toMatch(/const gift = plannedGift\(person\.id, kind, day, tasks\)/)
    expect(row).toMatch(/\{gift \? \([\s\S]*?onOpen\(gift\)[\s\S]*?Gift planned[\s\S]*?\) : \([\s\S]*?onPlanOccasion\(person, kind, day\)[\s\S]*?Plan a gift/)
  })

  it('finds the gift for the day the sheet shows', () => {
    expect(plannedGift('sam', 'birthday', birthday, [gift])?.id).toBe('g')
    // another occasion, another person, or a gift already given all still offer to plan
    expect(plannedGift('sam', 'anniversary', birthday, [gift])).toBeNull()
    expect(plannedGift('alex', 'birthday', birthday, [gift])).toBeNull()
    expect(plannedGift('sam', 'birthday', birthday, [{ ...gift, status: 'done' }])).toBeNull()
  })
})

describe('a gift someone else in the household is buying still counts', () => {
  // This suite was written when Mine / Everyone could narrow the Calendar's
  // tasks to your own, which lost a partner's gift and made the sheet offer a
  // second one. The switch is gone (v3.19: who a task is FOR is the record's
  // own flag, not a list filter), so there is one list again — and the rule
  // the day sheet asks must read it, not a subset of it.
  it('hands the Calendar one list of tasks, and the gift rule reads it', () => {
    const open = screen.indexOf('<Calendar')
    const tag = screen.slice(open, screen.indexOf('/>', open))
    expect(tag).toMatch(/\stasks=\{store\.tasks\}/)
    // no second list any more: nothing narrows what the Calendar is given
    expect(tag).not.toMatch(/allTasks/)
    expect(calendar).not.toMatch(/\ballTasks\b/)
    // the day buckets the month and week grids and the sheet's rows read
    expect(calendar).toMatch(/tasks: tasksByDay\(tasks\)/)
    expect(calendar).toMatch(/const gift = plannedGift\(person\.id, kind, day, tasks\)/)
  })

  it("finds a partner's gift, which is a task of theirs shared with the household", () => {
    const theirs: Task = { ...gift, ownerId: 'partner', assigneeId: 'partner' }
    const mine: Task = { ...gift, id: 'm', title: 'Book a table', tags: [], ownerId: 'me' }
    expect(plannedGift('sam', 'birthday', birthday, [theirs, mine])?.id).toBe('g')
    // and one they kept to themselves is not in this list at all — the server
    // never sent it (v3.19), so the sheet offers to plan a gift, as it should
    expect(plannedGift('sam', 'birthday', birthday, [mine])).toBeNull()
  })
})
