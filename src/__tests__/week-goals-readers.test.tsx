import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { draftIdOf, ownReviews, wantsDraft, weekReviewOf } from '../../netlify/functions/lib/sundaydraft.mjs'
import { previousWeekIn, sundayLine } from '../../netlify/functions/lib/reviewweek.mjs'
import { proposeWeek, type WeekPlan } from '../../shared/weekplan.mts'
import { Today } from '../components/Today'
import { shiftRange, weekRange } from '../review'
import type { Review, Task } from '../types'
import { withGoalToggled, withWeekGoals } from '../weekgoals'

// A week's goals set on Home live in the member's own review record for the
// week before, with nothing in it but `top` and `topDone`. Every reader of
// review records must take such a record for what it is — the week's goals —
// and never for a review: not "reviewed" on Home, not "written" in Sunday's
// digest line, not "drafted" to the background job, and never in the way of
// Sunday's draft for any week. The draft's end-to-end run over one is in
// srv-sundaydraft.test.ts ("a week’s 3 set on Home").

const ME = 'a1b2c3d4-0000-4000-8000-0000000000aa'
const PEER = 'e5f6a7b8-0000-4000-8000-0000000000bb'
/** Friday 25 September 2026, noon: Home sets the goals for the week of the 20th into the week of the 13th. */
const FRIDAY = new Date(2026, 8, 25, 12)
/** Sunday 27 September, 9am: the Sunday its week gets drafted is the one after — see below. */
const LAST_WEEK = shiftRange(weekRange(FRIDAY), -1).key
let ids = 0
const goals = (lines = ['Book the electrician', 'Finish the garage shelves', 'Date night Friday']) =>
  withWeekGoals([], lines, { noon: FRIDAY, now: FRIDAY, newId: () => `3f2c9a71-5d4e-4b8a-9c1f-00000000000${++ids}` })

beforeEach(() => {
  ids = 0
})

describe('a week’s goals, as Sunday’s draft job reads them', () => {
  it('still wants the week’s draft: goals, ticked or not, are not a review’s words', () => {
    const set = goals()
    expect(wantsDraft(set)).toBe(true)
    expect(wantsDraft(withGoalToggled(withGoalToggled(withGoalToggled(set, 0), 1), 2))).toBe(true)
    // what does stop it: words of the reader's own, or the draft's own claim
    expect(wantsDraft({ ...set, reflections: 'Less screen time' })).toBe(false)
    expect(wantsDraft({ ...set, summary: 'A steady week.' })).toBe(false)
    expect(wantsDraft({ ...set, draftedAt: '2026-09-20T07:00:00.000Z' })).toBe(false)
  })

  it('is the member’s own record for that week: the one the draft writes into, never a second', () => {
    const set = { ...goals(), ownerId: ME }
    // made the way the Review page makes one, with an id that is not Sunday's draft's
    expect(set.id.startsWith('review-')).toBe(false)
    expect(ownReviews([set], ME, LAST_WEEK)).toEqual([set])
    // …and never the other member's, whose own draft id is kept to them
    expect(ownReviews([set], PEER, LAST_WEEK)).toEqual([])
    const theirs = { ...set, id: draftIdOf(LAST_WEEK, PEER), ownerId: undefined }
    expect(ownReviews([theirs], ME, LAST_WEEK)).toEqual([])
  })

  it('is the week the digest looks at on its Sunday, and its line still invites the review', () => {
    // the Sunday after the week of the 13th is the 20th: that week is the one drafted then
    const sunday = new Date('2026-09-20T15:00:00Z')
    expect(previousWeekIn(sunday, 'America/Phoenix').key).toBe(LAST_WEEK)
    const set = { ...goals(), ownerId: ME }
    const review = weekReviewOf([set], ME, sunday, 'America/Phoenix')
    expect(review).toBe(set)
    expect(wantsDraft(review)).toBe(true)
    expect(sundayLine(review?.summary)).toBe('Sunday: time to look back on last week.')
  })
})

describe('a week’s goals, as the app reads them', () => {
  const STAMP = '2026-09-01T00:00:00.000Z'
  const noop = () => {}
  const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // the journal card asks the viewport how wide it is; a static render has none
    if (typeof window === 'undefined') vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function home(reviews: Review[], over: Partial<ComponentProps<typeof Today>> = {}) {
    const props: ComponentProps<typeof Today> = {
      tasks: [task('fence', { dueAt: new Date(2026, 8, 27, 18).toISOString() })],
      people: [],
      places: [],
      reviews,
      onPlanWith: noop,
      onWentTo: noop,
      onPlanAt: noop,
      onPlanOccasion: noop,
      onSaw: noop,
      onSaveReview: noop,
      projects: [],
      events: [],
      sourceMap: new Map(),
      onPlan: noop,
      onOpen: noop,
      onStatus: noop,
      onDefer: noop,
      onDeferAll: noop,
      onNew: noop,
      meals: [],
      recipes: [],
      onOpenKitchen: noop,
      onOpenReview: noop,
      onCookRecipe: noop,
      journal: [],
      onSaveJournal: noop,
      onDeleteJournal: noop,
      onOpenJournal: noop,
      habits: [],
      onSaveHabit: noop,
      onDeleteHabit: noop,
      routines: [],
      onSaveRoutine: noop,
      onDeleteRoutine: noop,
      onPlanWeek: noop,
      ...over,
    }
    return renderToStaticMarkup(<Today {...props} />)
  }

  it('on Home, the goals of this week and no “Your week is ready”: a review is its summary', () => {
    // Sunday the 27th: this week's 3 are in last week's record (the 20th's), which Home set
    vi.setSystemTime(new Date(2026, 8, 27, 9))
    const sunday = new Date(2026, 8, 27, 12)
    const set = withWeekGoals([], ['Book the electrician'], { noon: sunday, now: sunday, newId: () => 'home-set' })
    const html = home([set])
    expect(html).toContain('Book the electrician')
    expect(html).not.toContain('week-review-ready')
    expect(html).not.toContain('Your week is ready')
    // with the summary Sunday's draft writes into it, the card is back — and Plan next week is its, not the goals card's
    const drafted = home([{ ...set, summary: 'A steady week: the fence is fixed.', draftedAt: '2026-09-27T14:00:00.000Z' }])
    expect(drafted).toContain('Your week is ready')
    expect(drafted.match(/>Plan next week</g)).toHaveLength(1)
    // …and without it the goals card offers Plan next week, on a Sunday
    expect(html.match(/>Plan next week</g)).toHaveLength(1)
  })

  it('in Plan next week, the week’s own Top 3: none proposed over goals already set', () => {
    // Friday: the plan is for the week from Sunday the 27th, whose goals are in this week's record
    const thisWeek = { ...withWeekGoals([], ['Finish the garage shelves'], { noon: FRIDAY, now: FRIDAY, newId: () => 'mine' }), key: weekRange(FRIDAY).key }
    const tasks = [task('shelves', { title: 'Something else', dueAt: '2026-09-28T16:00:00.000Z' })]
    const plan = proposeWeek([...tasks, thisWeek], { todayKey: '2026-09-25', tz: 'America/Phoenix', userId: null, now: FRIDAY }) as WeekPlan
    expect(plan.week.prevWeekKey).toBe(thisWeek.key)
    expect(plan.top3).toEqual([])
  })
})
