import { describe, expect, it } from 'vitest'
import { ownVisit, plannedVisit, visitsFor } from '../../shared/people.mts'
import { outingsAt, type Outing } from '../../shared/places.mts'
import { mealOutings, taskIndex } from '../../shared/visitindex.mts'
import type { Meal, Task } from '../types'

// visitsFor, plannedVisit and outingsAt read an index filed once per list
// (shared/visitindex.mts) instead of walking the list for each person and
// place. These hold them to the answers they gave before: the three rules as
// they were, copied here word for word, against the indexed ones, over lists
// made at random — ties, duplicates, Trash, the other member's rows, meals
// still to come, and the malformed rows only a hand-written row could carry.

// ---- the rules as they were before the index (2026-09-23), verbatim

const OPEN = ['todo', 'doing', 'blocked']

function oldVisitsFor(personId: string, tasks: readonly Task[]) {
  return (tasks ?? [])
    .filter((t): t is Task & { completedAt: string } => t.status === 'done' && !!t.completedAt && (t.peopleIds ?? []).includes(personId))
    .map(t => ({ task: t, at: t.completedAt }))
    .sort((a, b) => b.at.localeCompare(a.at))
}

function oldPlannedVisit(personId: string, tasks: readonly Task[]): Task | null {
  return (
    (tasks ?? [])
      .filter(t => OPEN.includes(t.status) && (t.tags ?? []).includes('visit') && (t.peopleIds ?? []).includes(personId))
      .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.updatedAt.localeCompare(b.updatedAt))[0] ?? null
  )
}

const middayOf = (dateKey: string): string => `${dateKey}T12:00:00.000Z`

function oldOutingsAt(placeId: string, tasks: readonly Task[], meals: readonly Meal[] = [], now: Date | string = new Date(), myId: string | null = null): Outing[] {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const fromTasks = (tasks ?? [])
    .filter((t): t is Task & { completedAt: string } => t && !t.deletedAt && t.status === 'done' && !!t.completedAt && t.placeId === placeId && ownVisit(t, myId))
    .map((t): Outing => ({ kind: 'task', task: t, at: t.completedAt }))
  const fromMeals = (meals ?? [])
    .filter(m => m && !m.deletedAt && m.out === true && m.placeId === placeId && m.date && (m.shared !== false || ownVisit(m, myId)))
    .map((m): Outing => ({ kind: 'meal', meal: m, at: middayOf(m.date) }))
    .filter(v => Date.parse(v.at) <= nowMs)
  return [...fromTasks, ...fromMeals].sort((a, b) => b.at.localeCompare(a.at))
}

// ---- lists made at random, from a seed so a failure can be replayed

function rng(seed: number) {
  let s = seed
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]
  const chance = (p: number) => next() < p
  // a small seed's first draws are all near 0: let the generator run in first
  for (let i = 0; i < 8; i++) next()
  return { next, pick, chance }
}

const STAMP = '2026-01-01T00:00:00.000Z'
const PEOPLE: readonly unknown[] = ['mum', 'dad', 'sam', 'jo', 'ana', 'lee']
const PLACES: readonly unknown[] = ['nopi', 'pret', 'park', 'cafe']
const OWNERS = [undefined, 'me', 'you']
// few distinct instants, so ties are common and the order among them is tested
const INSTANTS = ['2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', '2026-08-20T18:30:00.000Z', '2026-07-04T12:00:00.000Z', '2025-12-24T20:00:00.000Z']
const DAYS = ['2026-09-01', '2026-09-22', '2026-09-23', '2026-09-24', '2026-10-01', '2025-06-30']
const STATUSES = ['todo', 'doing', 'blocked', 'done', 'done', 'done', 'wishlist', 'canceled']

function makeTasks(r: ReturnType<typeof rng>, n: number): Task[] {
  return Array.from({ length: n }, (_, i): Task => {
    const people = r.chance(0.2) ? undefined : Array.from({ length: Math.floor(r.next() * 4) }, () => r.pick(PEOPLE) as string)
    const tags = r.chance(0.1) ? undefined : r.chance(0.5) ? ['visit'] : r.chance(0.5) ? ['gift', 'visit'] : []
    const t: Task = {
      kind: 'task',
      id: `t${i}`,
      title: `Task ${i}`,
      description: '',
      status: r.pick(STATUSES) as Task['status'],
      priority: 'normal',
      tags: tags as string[],
      createdAt: r.pick(INSTANTS),
      updatedAt: r.pick(INSTANTS),
    }
    if (people) t.peopleIds = people
    if (r.chance(0.8)) t.completedAt = r.chance(0.1) ? '' : r.pick(INSTANTS)
    // now and then a place id no === can match, as a hand-written row might carry
    if (r.chance(0.5)) t.placeId = (r.chance(0.05) ? NaN : r.pick(PLACES)) as string
    if (r.chance(0.5)) t.dueAt = r.pick(INSTANTS)
    if (r.chance(0.15)) t.deletedAt = r.pick(INSTANTS)
    const owner = r.pick(OWNERS)
    if (owner) t.ownerId = owner
    if (r.chance(0.2)) t.assigneeId = r.pick(['me', 'you'])
    return t
  })
}

function makeMeals(r: ReturnType<typeof rng>, n: number): Meal[] {
  return Array.from({ length: n }, (_, i) => {
    const m = {
      kind: 'meal',
      id: `m${i}`,
      date: r.chance(0.1) ? '' : r.pick(DAYS),
      slot: 'dinner',
      title: `Meal ${i}`,
      createdAt: STAMP,
      updatedAt: STAMP,
    } as unknown as Meal
    if (r.chance(0.7)) m.out = r.chance(0.9) ? true : (('yes' as unknown) as boolean)
    if (r.chance(0.7)) m.placeId = (r.chance(0.05) ? NaN : r.pick(PLACES)) as string
    if (r.chance(0.3)) m.shared = r.chance(0.5)
    if (r.chance(0.1)) m.deletedAt = STAMP
    const owner = r.pick(OWNERS)
    if (owner) m.ownerId = owner
    return m
  })
}

const NOWS = [new Date('2026-09-23T15:00:00.000Z'), '2026-09-01T00:00:00.000Z', new Date('2027-01-01T00:00:00.000Z')]

/** What the comparisons below have seen, so a run that compared only empty answers cannot pass. */
const seen = { visits: 0, plans: 0, outings: 0, errors: 0 }
type Seen = Exclude<keyof typeof seen, 'errors'>

/** Both give the same answer, the same records by reference and in the same order — or both throw the same error. */
function same<T>(what: Seen, now: () => T, before: () => T): void {
  let want: { value?: T; error?: string }
  let got: { value?: T; error?: string }
  try {
    want = { value: before() }
  } catch (e) {
    want = { error: String(e) }
  }
  try {
    got = { value: now() }
  } catch (e) {
    got = { error: String(e) }
  }
  expect(got.error).toBe(want.error)
  expect(got.value).toEqual(want.value)
  if (want.error) seen.errors++
  else if (Array.isArray(want.value) ? want.value.length > 0 : want.value) seen[what]++
  // toEqual compares by value: the records must be the very same objects too
  const records = (v: unknown): unknown[] =>
    Array.isArray(v) ? v.map(x => (x && typeof x === 'object' && 'task' in x ? x.task : x && typeof x === 'object' && 'meal' in x ? x.meal : x)) : [v]
  records(got.value).forEach((r, i) => expect(r).toBe(records(want.value)[i]))
}

function holdsEverywhere(tasks: readonly Task[], meals: readonly Meal[]): void {
  const persons = [...PEOPLE, 'nobody', NaN, undefined]
  for (const id of persons) {
    same('visits', () => visitsFor(id as string, tasks), () => oldVisitsFor(id as string, tasks))
    same('plans', () => plannedVisit(id as string, tasks), () => oldPlannedVisit(id as string, tasks))
  }
  for (const id of [...PLACES, 'nowhere', NaN, undefined]) {
    for (const now of NOWS) {
      for (const myId of [null, 'me', 'you']) {
        same('outings', () => outingsAt(id as string, tasks, meals, now, myId), () => oldOutingsAt(id as string, tasks, meals, now, myId))
      }
    }
    // the meals left out, as most callers leave them
    same('outings', () => outingsAt(id as string, tasks), () => oldOutingsAt(id as string, tasks))
  }
}

describe('the visit and outing rules, read off the index', () => {
  it('answer as they did before, over two hundred lists made at random', () => {
    const before = { ...seen }
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      holdsEverywhere(makeTasks(r, Math.floor(r.next() * 60)), makeMeals(r, Math.floor(r.next() * 25)))
    }
    // most comparisons had something in them, not just two empty answers
    expect(seen.visits - before.visits).toBeGreaterThan(500)
    expect(seen.plans - before.plans).toBeGreaterThan(300)
    expect(seen.outings - before.outings).toBeGreaterThan(2000)
  })

  it('answer the second question about a list as the first', () => {
    const r = rng(7)
    const tasks = makeTasks(r, 80)
    const meals = makeMeals(r, 30)
    holdsEverywhere(tasks, meals)
    // now read off the index filed by the questions above
    expect(taskIndex(tasks)).toBe(taskIndex(tasks))
    expect(mealOutings(meals)).toBe(mealOutings(meals))
    holdsEverywhere(tasks, meals)
  })

  it('file a list again when it grows or shrinks in place', () => {
    const r = rng(11)
    const tasks = makeTasks(r, 40)
    const meals = makeMeals(r, 20)
    holdsEverywhere(tasks, meals)
    tasks.push(...makeTasks(r, 20))
    meals.push(...makeMeals(r, 10))
    holdsEverywhere(tasks, meals)
    tasks.splice(0, 30)
    meals.splice(0, 5)
    holdsEverywhere(tasks, meals)
  })

  it('count someone listed twice on one task once, as includes did', () => {
    const done: Task = { ...makeTasks(rng(3), 1)[0], status: 'done', completedAt: INSTANTS[0], tags: ['visit'], peopleIds: ['mum', 'mum', 'sam', 'mum'] }
    const plan: Task = { ...done, id: 'plan', status: 'todo', completedAt: undefined }
    const tasks = [done, plan]
    expect(visitsFor('mum', tasks)).toHaveLength(1)
    expect(plannedVisit('mum', tasks)).toBe(plan)
    holdsEverywhere(tasks, [])
  })

  it('read malformed rows exactly as the rules always did, the slow way', () => {
    const r = rng(5)
    const base = makeTasks(r, 30)
    const meals = makeMeals(r, 10)
    const odd = <T,>(row: T) => row as unknown as Task
    const cases: Task[][] = [
      // a missing row: visitsFor fails on it, outingsAt steps over it
      [...base, odd(null)],
      [odd(undefined), ...base],
      // people or tags as a string: includes finds any part of it
      [...base, { ...base[0], status: 'done', completedAt: INSTANTS[0], peopleIds: odd('mum,sam') as unknown as string[] }],
      [...base, { ...base[0], status: 'todo', peopleIds: ['mum'], tags: odd('visits') as unknown as string[] }],
      // a hole where a row should be: filter skips it
      Object.assign([...base], { 45: base[1] }),
    ]
    const errors = seen.errors
    for (const tasks of cases) holdsEverywhere(tasks, meals)
    // the missing row still fails visitsFor, as it always did
    expect(seen.errors).toBeGreaterThan(errors)
    // and meals with missing rows among them
    holdsEverywhere(base, [...meals, odd(null) as unknown as Meal, odd(undefined) as unknown as Meal])
  })

  it('read the lists once, however many people and places are asked about', () => {
    const r = rng(13)
    const rows = makeTasks(r, 200)
    // a list that counts how often its rows are read from the start
    let walks = 0
    const tasks = new Proxy(rows, {
      get(target, key, receiver) {
        if (key === '0') walks++
        return Reflect.get(target, key, receiver)
      },
    })
    for (let i = 0; i < 50; i++) {
      for (const id of PEOPLE) {
        visitsFor(id as string, tasks)
        plannedVisit(id as string, tasks)
      }
      for (const id of PLACES) outingsAt(id as string, tasks)
    }
    expect(walks).toBe(1)
  })
})
