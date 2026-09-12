import { describe, expect, it } from 'vitest'
import { catchUpTask, proposeWeek, targetWeek, weekPlanSummary } from '../../shared/weekplan.mjs'
import type { WeekPlan } from '../../shared/weekplan.mjs'
import { localMidnightIso } from '../../shared/domain.mjs'
import { weekKeyOf } from '../../shared/weeks.mjs'

// "Plan next week" is recomputed from the records every time and shared by the
// app and the Sunday digest, so these pin the proposal itself: which week,
// which recipe on which night, who to see and when, where overdue work goes,
// and that the same records always propose the same week.

const TZ = 'UTC'
const TODAY = '2026-09-16' // a Wednesday: the plan is for Sunday 20 – Saturday 26 September
const now = new Date('2026-09-16T08:00:00.000Z')
const STAMP = '2026-01-01T00:00:00.000Z'
const utc = (day: string, hm = '09:00') => `${day}T${hm}:00.000Z`

type Row = Record<string, unknown>
const recipe = (id: string, over: Row = {}): Row => ({ kind: 'recipe', id, name: id, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const meal = (date: string, recipeId: string | undefined, over: Row = {}): Row => ({
  kind: 'meal',
  id: `meal~${date}~${String(over.slot ?? 'dinner')}~${recipeId ?? 'none'}`,
  date,
  slot: 'dinner',
  ...(recipeId ? { recipeId } : {}),
  title: recipeId ?? 'Out',
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})
const cooked = (recipeId: string, ...dates: string[]) => dates.map(d => meal(d, recipeId))
const task = (id: string, over: Row = {}): Row => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })
const person = (id: string, over: Row = {}): Row => ({ kind: 'person', id, name: id, color: '#fff', group: 'friends', createdAt: STAMP, updatedAt: STAMP, ...over })
const visit = (id: string, personId: string, day: string) => task(id, { status: 'done', completedAt: utc(day, '12:00'), peopleIds: [personId], tags: ['visit'] })
const event = (id: string, title: string, start: string, end: string, over: Row = {}): Row => ({ kind: 'event', id, title, start, end, allDay: false, createdAt: STAMP, updatedAt: STAMP, ...over })

function items(): Row[] {
  return [
    // what has been cooked, and when
    recipe('fav'),
    ...cooked('fav', '2026-08-20', '2026-08-10', '2026-07-20', '2026-06-15', '2026-05-01'),
    recipe('mid'),
    ...cooked('mid', '2026-08-01', '2026-07-01', '2026-06-01'),
    recipe('a'),
    ...cooked('a', '2026-07-15', '2026-05-15'),
    recipe('b'),
    ...cooked('b', '2026-06-01'),
    recipe('c'),
    ...cooked('c', '2026-05-01'),
    recipe('d'),
    ...cooked('d', '2026-04-01'),
    recipe('old'),
    ...cooked('old', '2025-12-01'),
    recipe('recent'),
    ...cooked('recent', '2026-09-10'),
    recipe('planned'),
    ...cooked('planned', '2026-06-10', '2026-09-22'),
    recipe('never1', { createdAt: '2026-01-01T00:00:00.000Z' }),
    recipe('never2', { createdAt: '2026-06-01T00:00:00.000Z' }),
    meal('2026-09-21', undefined, { out: true, placeId: 'nopi', title: 'Nopi' }),
    meal('2026-09-24', undefined, { slot: 'lunch', title: 'Sandwich' }),
    // the week's calendar
    event('parents', "Parents' evening", utc('2026-09-23', '18:00'), utc('2026-09-23', '19:00')),
    event('office', 'In the office', utc('2026-09-24', '09:00'), utc('2026-09-24', '17:30'), { work: 'office' }),
    event('holiday', 'Bank holiday', '2026-09-25', '2026-09-26', { allDay: true }),
    event('lunch', 'Lunch with Sam', utc('2026-09-26', '12:00'), utc('2026-09-26', '13:00')),
    // people
    person('p-over', { cadenceDays: 14 }),
    visit('v1', 'p-over', '2026-08-01'),
    person('p-due', { cadenceDays: 30 }),
    visit('v2', 'p-due', '2026-08-10'),
    person('p-ok', { cadenceDays: 30 }),
    visit('v3', 'p-ok', '2026-09-10'),
    person('p-never-old'),
    person('p-never-new', { createdAt: '2026-09-01T00:00:00.000Z' }),
    person('p-planned', { cadenceDays: 14 }),
    visit('v4', 'p-planned', '2026-07-01'),
    task('plan-visit', { tags: ['visit'], peopleIds: ['p-planned'] }),
    // overdue work
    task('u1', { priority: 'urgent', dueAt: utc('2026-09-10') }),
    task('h1', { priority: 'high', dueAt: utc('2026-09-12') }),
    ...['01', '02', '03', '04', '05', '06'].map((d, i) => task(`n${i + 1}`, { dueAt: utc(`2026-09-${d}`) })),
    task('peer-late', { dueAt: utc('2026-09-11'), ownerId: 'peer' }),
    task('wish-late', { status: 'wishlist', dueAt: utc('2026-09-11') }),
    task('bill-late', { dueAt: utc('2026-09-10'), bill: { kind: 'bill' } }),
    // already due in the week
    task('s1', { dueAt: utc('2026-09-20', '10:00') }),
    task('s2', { dueAt: utc('2026-09-20', '10:00'), priority: 'high' }),
    task('s3', { dueAt: utc('2026-09-20', '10:00') }),
    task('m1', { dueAt: utc('2026-09-21', '10:00') }),
    task('m2', { dueAt: utc('2026-09-21', '10:00') }),
    // bills
    task('b-water', { title: 'Water', dueAt: utc('2026-09-24', '00:00'), estimateCost: 45, recurrence: { freq: 'monthly' }, bill: { kind: 'bill', autopay: true } }),
    task('b-later', { title: 'Phone', dueAt: utc('2026-09-30', '00:00'), bill: { kind: 'bill' } }),
  ]
}

const opts = { todayKey: TODAY, tz: TZ, userId: 'me', now }
const plan = proposeWeek(items(), opts) as WeekPlan

describe('targetWeek', () => {
  it('is the week starting today on a Sunday, and next Sunday on any other day', () => {
    expect(targetWeek('2026-09-13')).toEqual({
      startKey: '2026-09-13',
      dayKeys: ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'],
      weekKey: weekKeyOf('2026-09-13'),
      prevWeekKey: weekKeyOf('2026-09-06'),
    })
    expect(targetWeek('2026-09-16')?.startKey).toBe('2026-09-20')
    expect(targetWeek('2026-09-19')?.startKey).toBe('2026-09-20')
    expect(targetWeek('2026-12-30')?.dayKeys[0]).toBe('2027-01-03')
    expect(targetWeek('nope')).toBeNull()
    expect(proposeWeek(items(), { ...opts, todayKey: '2026-09-13', now: new Date('2026-09-13T08:00:00.000Z') })?.week.startKey).toBe('2026-09-13')
  })
})

describe('dinners', () => {
  it('fills the empty nights: favourites on quiet ones, one new recipe on Saturday, a busy night named', () => {
    expect(plan.dinners.map(d => [d.date, d.recipeId, d.busy, d.isNew])).toEqual([
      ['2026-09-20', 'fav', null, false],
      ['2026-09-23', 'd', "Parents' evening", false],
      ['2026-09-24', 'mid', null, false],
      ['2026-09-25', 'a', null, false],
      ['2026-09-26', 'never2', null, true],
    ])
    expect(plan.dinners[0].why).toBe('Cooked 5× in six months · last 27 days ago')
    expect(plan.dinners[4].why).toBe('Something new: saved, never cooked')
  })

  it('leaves a night with a dinner alone — eaten out included — but not one with only lunch', () => {
    const dates = plan.dinners.map(d => d.date)
    expect(dates).not.toContain('2026-09-21')
    expect(dates).not.toContain('2026-09-22')
    expect(dates).toContain('2026-09-24')
  })

  it('never suggests a recipe from the last fortnight, one planned that week, or one twice', () => {
    const everything = plan.dinners.flatMap(d => [d.recipeId, ...d.alternatives])
    expect(everything).not.toContain('recent')
    expect(everything).not.toContain('planned')
    const picks = plan.dinners.map(d => d.recipeId)
    expect(new Set(picks).size).toBe(picks.length)
    for (const d of plan.dinners) {
      expect(d.alternatives.length).toBeLessThanOrEqual(3)
      for (const alt of d.alternatives) expect(picks).not.toContain(alt)
    }
    expect(plan.dinners[0].alternatives).toEqual(['c', 'b', 'old'])
    expect(plan.dinners.filter(d => d.isNew)).toHaveLength(1)
  })

  it('reads a subscribed calendar’s evening too, but not a feed’s copy of our own entry', () => {
    const events = [
      { id: 'f1', sourceId: 's', title: 'Football', start: utc('2026-09-24', '18:30'), end: utc('2026-09-24', '19:30'), allDay: false },
      { id: 'local:x', sourceId: 'local', title: 'Echo', start: utc('2026-09-25', '18:30'), end: utc('2026-09-25', '19:30'), allDay: false, localId: 'x' },
    ]
    const withFeed = proposeWeek(items(), { ...opts, events }) as WeekPlan
    expect(withFeed.dinners.find(d => d.date === '2026-09-24')?.busy).toBe('Football')
    expect(withFeed.dinners.find(d => d.date === '2026-09-25')?.busy).toBeNull()
  })
})

describe('people', () => {
  it('suggests who is due or overdue (and the long-never-seen), not someone with a visit planned', () => {
    expect(plan.people.map(p => [p.personId, p.dueDay])).toEqual([
      ['p-over', '2026-09-26'],
      ['p-due', '2026-09-20'],
      ['p-never-old', '2026-09-21'],
    ])
    expect(plan.people[0].title).toBe('Catch up with p-over')
    expect(plan.people[0].why).toMatch(/you aimed for every 14 days/)
  })

  it('makes a catch-up a visit task due all day, which then suppresses them', () => {
    const t = catchUpTask(plan.people[0], { id: 'new-visit', now })
    expect(t).toMatchObject({ kind: 'task', id: 'new-visit', status: 'todo', tags: ['visit'], peopleIds: ['p-over'], dueAt: localMidnightIso('2026-09-26') })
    const next = proposeWeek([...items(), t], opts) as WeekPlan
    expect(next.people.map(p => p.personId)).not.toContain('p-over')
  })
})

describe('overdue', () => {
  it('spreads your overdue work, urgent first, never past three due on a day', () => {
    expect(plan.overdue.map(r => [r.taskId, r.toDay])).toEqual([
      ['u1', '2026-09-22'],
      ['h1', '2026-09-23'],
      ['n1', '2026-09-25'],
      ['n2', '2026-09-22'],
      ['n3', '2026-09-23'],
      ['n4', '2026-09-24'],
      ['n5', '2026-09-25'],
      ['n6', '2026-09-26'],
    ])
    expect(plan.overdue[0].why).toBe('Overdue 6 days · urgent')
    // Sunday already has three due and Monday two plus a catch-up: nothing lands there
    expect(plan.overdue.some(r => r.toDay === '2026-09-20' || r.toDay === '2026-09-21')).toBe(false)
    const already: Record<string, number> = { '2026-09-24': 1, '2026-09-26': 1 }
    const load = new Map<string, number>()
    for (const r of plan.overdue) load.set(r.toDay, (load.get(r.toDay) ?? 0) + 1)
    for (const [day, n] of load) expect(n + (already[day] ?? 0)).toBeLessThanOrEqual(3)
  })

  it('leaves out bills, a household member’s work and the wishlist', () => {
    const ids = plan.overdue.map(r => r.taskId)
    for (const id of ['bill-late', 'peer-late', 'wish-late']) expect(ids).not.toContain(id)
  })
})

describe('bills and Top 3', () => {
  it('lists bills due in the week as heads-ups', () => {
    expect(plan.bills).toEqual([{ key: 'bill:b-water', taskId: 'b-water', title: 'Water', dueDay: '2026-09-24', amount: 45, autopay: true }])
  })

  it('proposes a Top 3 from Next up only while last week’s review has none', () => {
    expect(plan.top3.map(t => [t.key, t.taskId])).toEqual([
      ['top:0', 's2'],
      ['top:1', 's1'],
      ['top:2', 's3'],
    ])
    const review = (top: string[], over: Row = {}): Row => ({ kind: 'review', id: 'r', period: 'week', key: weekKeyOf('2026-09-13'), top, createdAt: STAMP, updatedAt: STAMP, ...over })
    expect((proposeWeek([...items(), review(['Finish the shed'])], opts) as WeekPlan).top3).toEqual([])
    expect((proposeWeek([...items(), review(['  '])], opts) as WeekPlan).top3).toHaveLength(3)
    // someone else's review is not yours to have filled
    expect((proposeWeek([...items(), review(['Theirs'], { ownerId: 'peer' })], opts) as WeekPlan).top3).toHaveLength(3)
  })
})

describe('the proposal as a whole', () => {
  it('leaves out whatever was dismissed, and hands a dismissed night’s recipe to another', () => {
    const d = proposeWeek(items(), { ...opts, dismissed: ['dinner:2026-09-20', 'person:p-over', 'resched:u1', 'bill:b-water', 'top:0'] }) as WeekPlan
    expect(d.dinners.map(x => x.date)).not.toContain('2026-09-20')
    expect(d.dinners.find(x => x.recipeId === 'fav')?.date).toBe('2026-09-24')
    expect(d.people.map(p => p.personId)).not.toContain('p-over')
    expect(d.overdue.map(r => r.taskId)).not.toContain('u1')
    expect(d.bills).toEqual([])
    expect(d.top3.map(t => t.key)).toEqual(['top:1', 'top:2'])
  })

  it('drops what was accepted: a planned dinner fills its night and its recipe cools down', () => {
    const next = proposeWeek([...items(), meal('2026-09-20', 'fav')], opts) as WeekPlan
    expect(next.dinners.map(d => d.date)).not.toContain('2026-09-20')
    expect(next.dinners.flatMap(d => [d.recipeId, ...d.alternatives])).not.toContain('fav')
  })

  it('is the same week whatever order the records come in', () => {
    expect(proposeWeek([...items()].reverse(), opts)).toEqual(plan)
    expect(proposeWeek(items(), opts)).toEqual(plan)
  })

  it('sums itself up for the digest', () => {
    expect(weekPlanSummary(plan)).toBe('5 dinners to fill · 3 catch-ups · 8 overdue to move · 1 bill due · a Top 3 to pick')
    const one = { ...plan, dinners: plan.dinners.slice(0, 1), people: plan.people.slice(0, 1), overdue: [], bills: [], top3: [] }
    expect(weekPlanSummary(one)).toBe('1 dinner to fill · 1 catch-up')
    expect(weekPlanSummary({ ...plan, dinners: [], people: [], overdue: [], bills: [], top3: [] })).toBeNull()
    expect(weekPlanSummary(null)).toBeNull()
  })
})
