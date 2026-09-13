import { describe, expect, it } from 'vitest'
import type { AcceptedPlan, WeekPlan } from '../../shared/weekplan.mjs'
import { applyWeekPlanWrites, weekPlanToast, weekPlanWrites, weekWritesEmpty, type PlanPorts } from '../components/planner/useFocusActions'
import type { Item, Meal, Review, Task } from '../types'

// Plan next week, accepted: what the ticked rows write, and the one Undo that
// takes all of it back. The sheet itself writes nothing (p3-askplan-ui).

const STAMP = '2026-09-10T08:00:00.000Z'
const NOW = new Date(2026, 8, 12, 10, 0)
const ME = 'me'

const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const meal = (date: string, over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id: `meal~${date}~dinner`, date, slot: 'dinner', title: 'Soup', createdAt: STAMP, updatedAt: STAMP, ...over })
const review = (over: Partial<Review> = {}): Review => ({ kind: 'review', id: 'r1', period: 'week', key: '2026-W37', top: [], createdAt: STAMP, updatedAt: STAMP, ownerId: ME, ...over })

const PLAN = {
  week: { startKey: '2026-09-13', dayKeys: ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'], weekKey: '2026-W38', prevWeekKey: '2026-W37' },
  dinners: [],
  people: [],
  overdue: [],
  bills: [],
  top3: [],
} as unknown as WeekPlan

const accepted = (over: Partial<AcceptedPlan> = {}): AcceptedPlan => ({ dinners: [], people: [], resched: [], wishlist: [], top3: [], dismissed: [], ...over })

let n = 0
const opts = () => ({ myId: ME, now: NOW, newId: () => `new-${++n}` })

describe('Plan next week, accepted', () => {
  it('plans the dinners on nights still empty, and leaves a night planned meanwhile alone', () => {
    const items: Item[] = [meal('2026-09-14'), meal('2026-09-15', { deletedAt: STAMP })]
    const a = accepted({
      dinners: [
        { date: '2026-09-13', title: 'Pasta', recipeId: 'pasta' },
        { date: '2026-09-14', title: 'Curry', recipeId: 'curry' },
        { date: '2026-09-15', title: 'Nopi', out: true, placeId: 'nopi' },
      ],
    })
    const w = weekPlanWrites({ tasks: [], items, reviews: [] }, PLAN, a, opts())
    expect(w.meals.map(m => [m.date, m.title, m.recipeId, m.out, m.placeId])).toEqual([
      ['2026-09-13', 'Pasta', 'pasta', undefined, undefined],
      ['2026-09-15', 'Nopi', undefined, true, 'nopi'],
    ])
    // the night whose meal was deleted is planned again, stamped to win over the tombstone
    expect(w.meals[1].updatedAt > STAMP).toBe(true)
  })

  it('makes each catch-up a visit task, and moves overdue work to its day keeping its time', () => {
    const late = task('late', { dueAt: new Date(2026, 8, 1, 18, 30).toISOString(), status: 'wishlist' })
    const undated = task('undated')
    const done = task('done', { status: 'done' })
    const a = accepted({
      people: [{ personId: 'mum', dueDay: '2026-09-19', title: 'Catch up with Mum' }],
      resched: [
        { taskId: 'late', toDay: '2026-09-15' },
        { taskId: 'undated', toDay: '2026-09-16' },
        { taskId: 'done', toDay: '2026-09-16' },
      ],
    })
    const w = weekPlanWrites({ tasks: [late, undated, done], items: [], reviews: [] }, PLAN, a, opts())
    expect(w.created).toEqual([expect.objectContaining({ title: 'Catch up with Mum', peopleIds: ['mum'], tags: ['visit'], status: 'todo' })])
    expect(w.upserts.map(t => [t.id, t.dueAt, t.status])).toEqual([
      ['late', new Date(2026, 8, 15, 18, 30).toISOString(), 'todo'],
      ['undated', new Date(2026, 8, 16, 9, 0).toISOString(), 'todo'],
    ])
    expect(w.snapshots.map(t => t.id)).toEqual(['late', 'undated'])
  })

  it('sends work back to the wishlist through a status move', () => {
    const w = weekPlanWrites({ tasks: [task('a'), task('b', { status: 'wishlist' })], items: [], reviews: [] }, PLAN, accepted({ wishlist: ['a', 'b'] }), opts())
    expect(w.statuses).toEqual([{ id: 'a', status: 'wishlist' }])
    expect(w.snapshots.map(t => t.id)).toEqual(['a'])
  })

  it('writes the Top 3 into your own review of last week, making it when there is none', () => {
    const a = accepted({ top3: ['Boiler service', ' ', 'Book dentist'] })
    const fresh = weekPlanWrites({ tasks: [], items: [], reviews: [review({ id: 'peer', ownerId: 'peer' })] }, PLAN, a, opts())
    expect(fresh.review?.prev).toBeNull()
    expect(fresh.review?.next).toMatchObject({ kind: 'review', period: 'week', key: '2026-W37', top: ['Boiler service', 'Book dentist'] })
    expect(fresh.review?.next.id).not.toBe('peer')

    const mine = review({ reflections: 'A good week' })
    const kept = weekPlanWrites({ tasks: [], items: [], reviews: [mine] }, PLAN, a, opts())
    expect(kept.review?.prev).toBe(mine)
    expect(kept.review?.next).toMatchObject({ id: 'r1', reflections: 'A good week', top: ['Boiler service', 'Book dentist'] })
    expect(kept.review!.next.updatedAt > STAMP).toBe(true)
  })

  it('says what it did, and nothing at all when every row was already taken care of', () => {
    const w = weekPlanWrites(
      { tasks: [task('late', { dueAt: STAMP }), task('drop')], items: [], reviews: [] },
      PLAN,
      accepted({
        dinners: [{ date: '2026-09-13', title: 'Pasta' }, { date: '2026-09-14', title: 'Tacos' }],
        people: [{ personId: 'mum', dueDay: '2026-09-19', title: 'Catch up with Mum' }],
        resched: [{ taskId: 'late', toDay: '2026-09-15' }],
        wishlist: ['drop'],
        top3: ['One'],
      }),
      opts(),
    )
    expect(weekPlanToast(w)).toBe('Next week planned · 2 dinners · 1 catch-up · 2 moved · Top 3 set')
    expect(weekWritesEmpty(weekPlanWrites({ tasks: [], items: [meal('2026-09-13')], reviews: [] }, PLAN, accepted({ dinners: [{ date: '2026-09-13', title: 'Pasta' }] }), opts()))).toBe(true)
  })
})

describe('its one Undo', () => {
  function ports(tasks: Task[]) {
    const log: string[] = []
    let live = [...tasks]
    const p: PlanPorts = {
      tasks: () => live,
      upsert: item => {
        log.push(`upsert ${item.kind} ${item.id}`)
        if (item.kind === 'task') live = [...live.filter(t => t.id !== item.id), item]
      },
      remove: id => void log.push(`remove ${id}`),
      applyStatus: (id, status) => {
        log.push(`status ${id} ${status}`)
        return null
      },
      pushToProjectBoard: t => void log.push(`board ${t.id}`),
      mirrorEvent: () => {},
      removeEvent: () => {},
      saveMeals: ms => void log.push(`saveMeals ${ms.map(m => m.id).join(',')}`),
      clearMeals: ids => void log.push(`clearMeals ${ids.join(',')}`),
    }
    return { ports: () => p, log, live: () => live }
  }

  it('takes back every write, and removes a review the plan made', () => {
    const late = task('late', { dueAt: STAMP })
    const w = weekPlanWrites(
      { tasks: [late, task('drop')], items: [], reviews: [] },
      PLAN,
      accepted({
        dinners: [{ date: '2026-09-13', title: 'Pasta' }],
        people: [{ personId: 'mum', dueDay: '2026-09-19', title: 'Catch up with Mum' }],
        resched: [{ taskId: 'late', toDay: '2026-09-15' }],
        wishlist: ['drop'],
        top3: ['One'],
      }),
      opts(),
    )
    const s = ports([late, task('drop')])
    const undo = applyWeekPlanWrites(s.ports, w)
    const catchUp = w.created[0].id
    const made = w.review!.next.id
    expect(s.log).toEqual(['upsert task late', 'board late', 'status drop wishlist', `upsert task ${catchUp}`, 'saveMeals meal~2026-09-13~dinner', `upsert review ${made}`])

    s.log.length = 0
    undo()
    expect(s.log).toContain(`remove ${catchUp}`)
    expect(s.log).toContain('clearMeals meal~2026-09-13~dinner')
    expect(s.log).toContain(`remove ${made}`)
    // the moved task is back as it was, stamped to win over the plan's own write
    const back = s.live().find(t => t.id === 'late')!
    expect(back.dueAt).toBe(STAMP)
    expect(back.updatedAt > w.upserts[0].updatedAt).toBe(true)
  })

  it('puts back a review that was already there', () => {
    const mine = review({ top: [] })
    const w = weekPlanWrites({ tasks: [], items: [], reviews: [mine] }, PLAN, accepted({ top3: ['One'] }), opts())
    const s = ports([])
    const upserts: Item[] = []
    const p = s.ports()
    const undo = applyWeekPlanWrites(() => ({ ...p, upsert: item => void upserts.push(item) }), w)
    undo()
    const restored = upserts[upserts.length - 1] as Review
    expect(restored).toMatchObject({ id: 'r1', top: [] })
    expect(restored.updatedAt > w.review!.next.updatedAt).toBe(true)
  })
})
