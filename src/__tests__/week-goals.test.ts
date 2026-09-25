import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusCandidates } from '../focus'
import { shiftRange, weekRange } from '../review'
import type { Review, Task } from '../types'
import {
  WEEK_GOALS,
  allDoneLine,
  cleanGoals,
  finishesGoals,
  goalsOf,
  goalsWeekKey,
  intoFirstEmpty,
  unfinishedGoals,
  weekGoalsRecord,
  withGoalToggled,
  withWeekGoals,
} from '../weekgoals'

// This week's 3 are the Review's Top 3: record N holds the goals for week
// N + 1. Home reads last week's record (falling back to this week's), sets
// the goals by writing last week's — making it when there is none — and
// ticks them in its topDone. These pin that, and what Plan my day and the
// Sunday review read of the same lines.

const NOON = new Date(2026, 8, 25, 12) // Friday 25 September 2026
const THIS_WEEK = weekRange(NOON).key
const LAST_WEEK = shiftRange(weekRange(NOON), -1).key
const STAMP = '2026-09-20T10:00:00.000Z'
const review = (key: string, over: Partial<Review> = {}): Review => ({ kind: 'review', id: `r-${key}`, period: 'week', key, top: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })
let ids = 0
const newId = () => `new-${++ids}`

beforeEach(() => {
  ids = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 25, 9, 30))
})
afterEach(() => vi.useRealTimers())

describe('whose Top 3 are this week’s', () => {
  it('reads last week’s record, written “for next week”, before this week’s own', () => {
    const last = review(LAST_WEEK, { top: ['Book the electrician'] })
    const mine = review(THIS_WEEK, { top: ['Next week’s'] })
    expect(weekGoalsRecord([mine, last], NOON)).toBe(last)
    expect(goalsWeekKey(NOON)).toBe(LAST_WEEK)
  })

  it('falls back to this week’s only when last week has no record at all', () => {
    const mine = review(THIS_WEEK, { top: ['Finish the shelves'] })
    expect(weekGoalsRecord([mine], NOON)).toBe(mine)
    // a record for last week, even one without goals (Sunday's draft made it), is the week's
    const drafted = review(LAST_WEEK, { summary: 'A steady week.', draftedAt: STAMP })
    expect(weekGoalsRecord([mine, drafted], NOON)).toBe(drafted)
  })

  it('of two copies of last week’s, reads the one holding goals', () => {
    const drafted = review(LAST_WEEK, { id: 'review-2026-W38-a1b2c3d4', summary: 'A steady week.' })
    const set = review(LAST_WEEK, { id: 'home', top: ['Date night'] })
    expect(weekGoalsRecord([drafted, set], NOON)).toBe(set)
  })

  it('ignores a month’s review and a deleted one', () => {
    expect(weekGoalsRecord([review(LAST_WEEK, { period: 'month', top: ['x'] }), review(LAST_WEEK, { top: ['y'], deletedAt: STAMP })], NOON)).toBeUndefined()
  })

  it('reads its lines trimmed, the empty ones out, three at most, each with its place in topDone', () => {
    const r = review(LAST_WEEK, { top: [' Book the electrician ', '', 'Garage shelves', 'Date night', 'Fourth'], topDone: [true, true, false, true] })
    expect(goalsOf(r)).toEqual([
      { text: 'Book the electrician', index: 0, done: true },
      { text: 'Garage shelves', index: 2, done: false },
      { text: 'Date night', index: 3, done: true },
    ])
    expect(goalsOf(undefined)).toEqual([])
  })
})

describe('setting this week’s 3 on Home', () => {
  it('writes last week’s record, with only its Top 3 changed, stamped newer', () => {
    const last = review(LAST_WEEK, { summary: 'A steady week.', reflections: 'Less screen time', draftedAt: STAMP, top: ['Old'] })
    const next = withWeekGoals([last], ['Book the electrician', ' Garage shelves ', ''], { noon: NOON, now: new Date(), newId })
    expect(next).toEqual({ ...last, top: ['Book the electrician', 'Garage shelves'], topDone: [false, false], updatedAt: next.updatedAt })
    expect(next.updatedAt > last.updatedAt).toBe(true)
    expect(ids).toBe(0)
  })

  it('makes last week’s record when there is none: a week, its key, a new id, and nothing but the goals', () => {
    const next = withWeekGoals([], ['Book the electrician', 'Garage shelves', 'Date night', 'A fourth'], { noon: NOON, now: new Date(), newId })
    expect(next).toEqual({
      kind: 'review',
      id: 'new-1',
      period: 'week',
      key: LAST_WEEK,
      top: ['Book the electrician', 'Garage shelves', 'Date night'],
      topDone: [false, false, false],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    // never a review's words, and never Sunday's claim on the week
    expect(next).not.toHaveProperty('summary')
    expect(next).not.toHaveProperty('reflections')
    expect(next).not.toHaveProperty('draftedAt')
  })

  it('never writes this week’s record, whose Top 3 are next week’s', () => {
    const mine = review(THIS_WEEK, { top: ['Next week’s'] })
    const next = withWeekGoals([mine], ['Garage shelves'], { noon: NOON, now: new Date(), newId })
    expect(next.key).toBe(LAST_WEEK)
    expect(next.id).toBe('new-1')
  })

  it('keeps a kept goal’s tick, whatever its case or place, and starts a new or reworded one unticked', () => {
    const last = review(LAST_WEEK, { top: ['Book the electrician', 'Garage shelves', 'Date night'], topDone: [true, false, true] })
    const next = withWeekGoals([last], ['date night', 'Garage shelves', 'Book an electrician'], { noon: NOON, now: new Date(), newId })
    expect(next.top).toEqual(['date night', 'Garage shelves', 'Book an electrician'])
    expect(next.topDone).toEqual([true, false, false])
  })

  it('carries the ticks of goals shown from this week’s record into last week’s new one', () => {
    const mine = review(THIS_WEEK, { top: ['Garage shelves'], topDone: [true] })
    expect(withWeekGoals([mine], ['Garage shelves', 'Date night'], { noon: NOON, now: new Date(), newId }).topDone).toEqual([true, false])
  })

  it('clears them when every line is emptied', () => {
    const last = review(LAST_WEEK, { top: ['Book the electrician'], topDone: [true] })
    expect(withWeekGoals([last], ['', '  ', ''], { noon: NOON, now: new Date(), newId })).toMatchObject({ top: [], topDone: [] })
    expect(cleanGoals([' a ', '', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c'])
  })

  it('is what Plan my day offers as “this week’s 3”', () => {
    const set = withWeekGoals([], ['Fix the gate', 'Garage shelves'], { noon: NOON, now: new Date(), newId })
    const ticked = withGoalToggled(set, 1)
    const tasks = [task('gate', { title: 'Fix the gate' }), task('shelves', { title: 'Garage shelves' })]
    const offered = focusCandidates({ tasks, projects: [], reviews: [ticked], today: '2026-09-25', now: NOON, myId: null })
    expect(offered.filter(c => c.group === 'weekTop').map(c => c.task.id)).toEqual(['gate'])
  })
})

describe('ticking a goal', () => {
  it('flips its own place in topDone, keeping the rest, stamped newer', () => {
    const r = review(LAST_WEEK, { top: ['a', 'b', 'c'] })
    const once = withGoalToggled(r, 1)
    expect(once.topDone).toEqual([false, true, false])
    expect(once.updatedAt > r.updatedAt).toBe(true)
    expect(withGoalToggled(once, 1).topDone).toEqual([false, false, false])
  })

  it('cheers only on the tick that finishes them, never on one that does not', () => {
    const goals = goalsOf(review(LAST_WEEK, { top: ['a', 'b', 'c'], topDone: [true, false, true] }))
    expect(finishesGoals(goals, 1)).toBe(true)
    expect(finishesGoals(goals, 0)).toBe(false)
    const two = goalsOf(review(LAST_WEEK, { top: ['a', 'b', 'c'], topDone: [false, false, true] }))
    expect(finishesGoals(two, 1)).toBe(false)
    // all ticked already: unticking one is no cheer
    expect(finishesGoals(goalsOf(review(LAST_WEEK, { top: ['a'], topDone: [true] })), 0)).toBe(false)
    expect(finishesGoals(goals, 7)).toBe(false)
  })

  it('says “All 3 done”, or as many as there are', () => {
    expect(allDoneLine(WEEK_GOALS)).toBe('All 3 done')
    expect(allDoneLine(2)).toBe('Both done')
    expect(allDoneLine(1)).toBe('Done')
  })
})

describe('carrying the unfinished ones over', () => {
  it('offers the period’s unticked goals that are not in next period’s Top 3 yet', () => {
    const prev = review(LAST_WEEK, { top: ['Book the electrician', 'Garage shelves', 'Date night'], topDone: [true, false, false] })
    expect(unfinishedGoals(prev, ['', '', ''])).toEqual(['Garage shelves', 'Date night'])
    expect(unfinishedGoals(prev, ['garage shelves ', '', ''])).toEqual(['Date night'])
    expect(unfinishedGoals(undefined, ['', '', ''])).toEqual([])
  })

  it('fills the first empty line, and nothing when none is', () => {
    expect(intoFirstEmpty(['Paint', '', ''], 'Garage shelves')).toEqual(['Paint', 'Garage shelves', ''])
    expect(intoFirstEmpty(['', 'Paint', ''], 'Garage shelves')).toEqual(['Garage shelves', 'Paint', ''])
    expect(intoFirstEmpty(['a', 'b', 'c'], 'd')).toEqual(['a', 'b', 'c'])
  })
})
