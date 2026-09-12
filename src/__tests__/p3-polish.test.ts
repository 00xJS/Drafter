import { afterEach, describe, expect, it, vi } from 'vitest'
import { polishWeekPlan, weekPolishInput } from '../ai'
import { proposeWeek } from '../../shared/weekplan.mjs'
import type { WeekPlan } from '../../shared/weekplan.mjs'
import type { Meal, Person, Recipe, Task } from '../types'

// The ✨ polish of a week plan is only ever a proposal: it may pick among each
// night's own candidates and the people listed, and anything else it says is
// dropped. It never sees the journal, anyone's notes, or a real id.

const STAMP = '2026-01-01T00:00:00.000Z'
const now = new Date('2026-09-16T08:00:00.000Z')
const recipe = (id: string, name: string, tags: string[] = []): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags, notes: 'Grandma’s secret: extra butter', createdAt: STAMP, updatedAt: STAMP })
const meal = (id: string, date: string, recipeId: string): Meal => ({ kind: 'meal', id, date, slot: 'dinner', recipeId, title: recipeId, createdAt: STAMP, updatedAt: STAMP })
const recipes = [recipe('id-r1', 'Lasagne', ['pasta']), recipe('id-r2', 'Curry'), recipe('id-r3', 'Tacos'), recipe('id-r4', 'Stew'), recipe('id-r5', 'Risotto'), recipe('id-r6', 'Pie')]
const meals = [
  meal('m1', '2026-08-01', 'id-r1'),
  meal('m2', '2026-07-01', 'id-r1'),
  meal('m3', '2026-06-01', 'id-r1'),
  meal('m4', '2026-08-02', 'id-r2'),
  meal('m5', '2026-07-02', 'id-r2'),
  meal('m6', '2026-08-03', 'id-r3'),
  meal('m7', '2026-08-04', 'id-r4'),
  meal('m8', '2026-08-05', 'id-r5'),
  meal('m9', '2026-08-06', 'id-r6'),
]
const people: Person[] = [
  { kind: 'person', id: 'id-mum', name: 'Mum', color: '#fff', group: 'family', cadenceDays: 14, notes: 'Allergic to nuts', createdAt: STAMP, updatedAt: STAMP },
  { kind: 'person', id: 'id-dad', name: 'Dad', color: '#fff', group: 'family', createdAt: STAMP, updatedAt: STAMP },
]
const tasks: Task[] = [
  { kind: 'task', id: 'id-v1', title: 'Lunch', description: '', status: 'done', priority: 'normal', completedAt: '2026-08-01T12:00:00.000Z', peopleIds: ['id-mum'], tags: ['visit'], createdAt: STAMP, updatedAt: STAMP },
  { kind: 'task', id: 'id-t1', title: 'Fix the fence', description: '', status: 'todo', priority: 'normal', dueAt: '2026-09-10T09:00:00.000Z', tags: [], createdAt: STAMP, updatedAt: STAMP },
]
// two nights left to plan, so each has spare candidates to choose between
const dismissed = ['22', '23', '24', '25', '26'].map(d => `dinner:2026-09-${d}`)
const plan = proposeWeek([...recipes, ...meals, ...people, ...tasks], { todayKey: '2026-09-16', tz: 'UTC', userId: null, now, dismissed }) as WeekPlan
const input = weekPolishInput(plan, { recipes, people, meals, tasks, now })

describe('weekPolishInput', () => {
  it('offers each night its pick and alternatives under references, with tags and cook counts', () => {
    expect(input.nights.map(n => [n.date, n.weekday, n.candidates.map(c => c.ref)])).toEqual([
      ['2026-09-20', 'Sunday', ['R1', 'R2', 'R3', 'R4']],
      ['2026-09-21', 'Monday', ['R5', 'R6', 'R2', 'R3']],
    ])
    expect(input.nights[0].candidates[0]).toEqual({ ref: 'R1', id: 'id-r1', name: 'Lasagne', tags: ['pasta'], cooked: 3 })
    expect(input.people).toEqual([
      { ref: 'P1', id: 'id-mum', name: 'Mum', daysSince: 45 },
      { ref: 'P2', id: 'id-dad', name: 'Dad', daysSince: null },
    ])
    expect(input.overdue).toEqual(['Fix the fence'])
  })
})

describe('polishWeekPlan', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubAI = (answer: unknown) => {
    const prompts: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        prompts.push(`${body.system}\n${body.prompt}`)
        return Response.json({ text: JSON.stringify(answer) })
      }),
    )
    return prompts
  }

  it('accepts only a night’s own candidates, each once, and only the people listed', async () => {
    const [n0, n1] = input.nights
    const refs = (n: typeof n0) => n.candidates.map(c => c.ref)
    const both = refs(n0).find(r => refs(n1).includes(r))!
    const only0 = refs(n0).find(r => !refs(n1).includes(r))!
    const only1 = refs(n1).find(r => !refs(n0).includes(r))!
    stubAI({
      dinners: [
        { date: n0.date, recipeRef: both },
        { date: n1.date, recipeRef: only0 }, // not one of Monday's
        { date: n1.date, recipeRef: both }, // already Sunday's
        { date: '2027-01-01', recipeRef: only0 }, // not a night in the plan
        { date: n1.date, recipeRef: only1.toLowerCase() },
        { date: n0.date, recipeRef: only0 }, // Sunday is taken
        'nonsense',
      ],
      note: '  A calm week with one late night.  ',
      catchUps: [
        { personRef: 'P1', idea: 'Call her on Sunday afternoon' },
        { personRef: 'P9', idea: 'Someone invented' },
        { personRef: 'P1', idea: 'A second idea for Mum' },
        { personRef: 'P2', idea: '   ' },
      ],
    })
    expect(await polishWeekPlan(input)).toEqual({
      dinners: [
        { date: n0.date, recipeRef: both },
        { date: n1.date, recipeRef: only1 },
      ],
      note: 'A calm week with one late night.',
      catchUps: [{ personRef: 'P1', idea: 'Call her on Sunday afternoon' }],
    })
  })

  it('never sends a real id, anyone’s notes or a recipe’s', async () => {
    const prompts = stubAI({ dinners: [], note: '', catchUps: [] })
    await polishWeekPlan(input)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('id-')
    expect(prompts[0]).not.toMatch(/Allergic|Grandma/)
    expect(prompts[0]).toContain('R1 Lasagne [pasta] ×3')
    expect(prompts[0]).toContain('P1 Mum: last seen 45 days ago')
  })
})
