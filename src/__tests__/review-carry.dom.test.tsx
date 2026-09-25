// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Review } from '../components/Review'
import { shiftRange, weekRange } from '../review'
import type { Review as ReviewRecord } from '../types'
import { withGoalToggled, withWeekGoals } from '../weekgoals'

// The week's 3 set on Home are the Sunday review's "Last week's Top 3 — tick
// what you kept", and the ones left unticked are offered again, a tap each,
// for the week ahead's Top 3.

const noop = () => {}
/** Friday 25 September: Home set the week's 3 for the week of the 20th. */
const FRIDAY = new Date(2026, 8, 25, 12)
const WEEK = weekRange(FRIDAY).key

function sundayReview(reviews: ReviewRecord[]) {
  const onSaveReview = vi.fn<(r: ReviewRecord) => void>()
  render(<Review tasks={[]} projects={[]} people={[]} reviews={reviews} journal={[]} places={[]} habits={[]} onSaveReview={onSaveReview} onOpen={noop} onStatus={noop} onDeferAll={noop} onStatusAll={noop} onNew={noop} />)
  return onSaveReview
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Sunday 27 September: the review is of the week that just ended
  vi.setSystemTime(new Date(2026, 8, 27, 10))
})
afterEach(() => vi.useRealTimers())

const homeGoals = () => withGoalToggled(withWeekGoals([], ['Book the electrician', 'Finish the garage shelves', 'Date night Friday'], { noon: FRIDAY, now: FRIDAY, newId: () => 'home' }), 0)

describe('the goals set on Home, in the Sunday review', () => {
  it('are last week’s Top 3 to tick, with Home’s ticks', () => {
    const save = sundayReview([homeGoals()])
    const said = screen.getByRole('heading', { name: 'You said' }).closest('section')!
    const kept = within(said).getByRole('checkbox', { name: 'Kept “Book the electrician”' }) as HTMLInputElement
    expect(kept.checked).toBe(true)
    fireEvent.click(within(said).getByRole('checkbox', { name: 'Kept “Date night Friday”' }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ id: 'home', topDone: [true, false, true] })
  })

  it('offers the unticked ones for next week’s Top 3, each filling the first empty line', () => {
    const save = sundayReview([homeGoals()])
    const carry = screen.getByRole('group', { name: 'Unfinished goals to carry over' })
    expect(within(carry).getAllByRole('button').map(b => b.textContent)).toEqual(['Carry over: Finish the garage shelves', 'Carry over: Date night Friday'])
    fireEvent.click(within(carry).getByRole('button', { name: 'Carry over “Date night Friday”' }))
    // written into the review of the week just ended, as its Top 3 for next week
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ kind: 'review', period: 'week', key: WEEK, top: ['Date night Friday'] })
    expect((screen.getByPlaceholderText('#1') as HTMLInputElement).value).toBe('Date night Friday')
    // offered once: what is carried over is no longer offered
    expect(within(screen.getByRole('group', { name: 'Unfinished goals to carry over' })).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Carry over “Finish the garage shelves”'])
  })

  it('offers none that is already among next week’s lines, whatever its case', () => {
    const next = (top: string[]): ReviewRecord => ({ kind: 'review', id: 'next', period: 'week', key: WEEK, top, createdAt: '2026-09-27T09:00:00.000Z', updatedAt: '2026-09-27T09:00:00.000Z' })
    sundayReview([homeGoals(), next(['finish the garage shelves', 'Paint the fence'])])
    const carry = screen.getByRole('group', { name: 'Unfinished goals to carry over' })
    expect(within(carry).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Carry over “Date night Friday”'])
  })

  it('offers nothing once every line of next week’s Top 3 is taken', () => {
    sundayReview([homeGoals(), { kind: 'review', id: 'next', period: 'week', key: WEEK, top: ['Paint the fence', 'Call Mum', 'Tidy the loft'], createdAt: '2026-09-27T09:00:00.000Z', updatedAt: '2026-09-27T09:00:00.000Z' }])
    expect(screen.queryByRole('group', { name: 'Unfinished goals to carry over' })).toBeNull()
    expect(homeGoals().key).toBe(shiftRange(weekRange(FRIDAY), -1).key)
  })
})
