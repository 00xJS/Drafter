import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMineOnly } from '../components/planner/useMineOnly'
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
    expect(row).toMatch(/const gift = plannedGift\(person\.id, kind, sheetDay, allTasks \?\? tasks\)/)
    expect(row).toMatch(/\{gift \? \([\s\S]*?onOpen\(gift\)[\s\S]*?Gift planned[\s\S]*?\) : \([\s\S]*?onPlanOccasion\(person, kind, at\)[\s\S]*?Plan a gift/)
  })

  it('finds the gift for the day the sheet shows', () => {
    expect(plannedGift('sam', 'birthday', birthday, [gift])?.id).toBe('g')
    // another occasion, another person, or a gift already given all still offer to plan
    expect(plannedGift('sam', 'anniversary', birthday, [gift])).toBeNull()
    expect(plannedGift('alex', 'birthday', birthday, [gift])).toBeNull()
    expect(plannedGift('sam', 'birthday', birthday, [{ ...gift, status: 'done' }])).toBeNull()
  })
})

describe('with Mine on, a gift someone else in the household is buying still counts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('gives the gift rule every task, and every grid and list the Mine list', () => {
    const open = screen.indexOf('<Calendar')
    const tag = screen.slice(open, screen.indexOf('/>', open))
    expect(tag).toMatch(/\stasks=\{filteredTasks\}/)
    expect(tag).toMatch(/\sallTasks=\{store\.tasks\}/)
    // the day buckets the month and week grids and the sheet's rows read are still built from `tasks`
    expect(calendar).toMatch(/tasks: tasksByDay\(tasks\)/)
    // `allTasks` is declared, taken, and read in one place: the gift rule, falling back to `tasks`
    const code = calendar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code.match(/\ballTasks\b/g)).toHaveLength(3)
  })

  it("finds a partner's gift among every task, where the Mine list has lost it", () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'drafter:mine-only' ? '1' : null), setItem: () => {} })
    const theirs: Task = { ...gift, ownerId: 'partner', assigneeId: 'partner' }
    const mine: Task = { ...gift, id: 'm', title: 'Book a table', tags: [], ownerId: 'me' }
    const all = [theirs, mine]
    const args = {
      store: { tasks: all },
      household: { myId: 'me', info: { household: { id: 'h' }, members: [{ userId: 'me' }, { userId: 'partner' }] } },
    } as unknown as Parameters<typeof useMineOnly>[0]
    // useMineOnly's own Mine filter, through one server render (no effects run)
    const Probe = () => createElement('i', null, useMineOnly(args).filteredTasks.map(t => t.id).join(','))
    const shown = renderToStaticMarkup(createElement(Probe)).replace(/<\/?i>/g, '').split(',')
    expect(shown).toEqual(['m'])
    const mineOnly = all.filter(t => shown.includes(t.id))
    // what the sheet asked before, and what it asks now
    expect(plannedGift('sam', 'birthday', birthday, mineOnly)).toBeNull()
    expect(plannedGift('sam', 'birthday', birthday, all)?.id).toBe('g')
  })
})
