import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { plannedGift } from '../people'
import { Task } from '../types'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const calendar = read('../components/Calendar.tsx')
const today = read('../components/Today.tsx')

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
    expect(row).toMatch(/const gift = plannedGift\(person\.id, kind, sheetDay, tasks\)/)
    expect(row).toMatch(/\{gift \? \([\s\S]*?onOpen\(gift\)[\s\S]*?Gift planned[\s\S]*?\) : \([\s\S]*?onPlanOccasion\(person, kind, at\)[\s\S]*?Plan a gift/)
  })

  it('finds the gift for the day the sheet shows', () => {
    // the sheet holds the occasion's day at local midnight; the gift was
    // planned for the weekend before
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
    expect(plannedGift('sam', 'birthday', birthday, [gift])?.id).toBe('g')
    // another occasion, another person, or a gift already given all still offer to plan
    expect(plannedGift('sam', 'anniversary', birthday, [gift])).toBeNull()
    expect(plannedGift('alex', 'birthday', birthday, [gift])).toBeNull()
    expect(plannedGift('sam', 'birthday', birthday, [{ ...gift, status: 'done' }])).toBeNull()
  })
})
