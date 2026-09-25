// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Review } from '../types'

// This week's 3 on Home: set there with none set, edited there, ticked there,
// and cheered when the last one is ticked — once for that tick, never as the
// card draws — with a success buzz on the phone and, under Reduce Motion, the
// words alone. Mounted as the compiler builds it (dom.ts).

const buzz = vi.hoisted(() => ({ haptic: vi.fn(async (_kind?: string) => {}) }))
vi.mock('../native', () => buzz)

import { WeekGoals } from '../components/home/WeekGoals'
import { shiftRange, weekRange } from '../review'

const NOON = new Date(2026, 8, 25, 12) // Friday 25 September
const LAST_WEEK = shiftRange(weekRange(NOON), -1).key
const STAMP = '2026-09-20T10:00:00.000Z'
const last = (over: Partial<Review> = {}): Review => ({ kind: 'review', id: 'r-last', period: 'week', key: LAST_WEEK, top: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const noop = () => {}
/** The card's line under its title: a live region, so what it says is read out as it changes. */
const said = () => {
  const line = document.querySelector('.goals-words [aria-live="polite"]')
  return line?.textContent
}

/** matchMedia answering Reduce Motion as asked. */
function motion(reduced: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('prefers-reduced-motion'), media: q, addEventListener: noop, removeEventListener: noop }))
}

function card(record: Review | undefined, over: Partial<Parameters<typeof WeekGoals>[0]> = {}) {
  const onSave = vi.fn<(r: Review) => void>()
  const onMakeTask = vi.fn<(line: string) => void>()
  const view = render(<WeekGoals reviews={record ? [record] : []} record={record} noon={NOON} focusTitles={new Set()} onSave={onSave} onMakeTask={onMakeTask} {...over} />)
  return { view, onSave, onMakeTask }
}

beforeEach(() => {
  buzz.haptic.mockClear()
  motion(false)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 25, 9, 0))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('with none set', () => {
  it('asks for them: three lines and Save, which waits for words', () => {
    card(undefined)
    expect(screen.getByRole('heading', { name: 'Set this week’s 3' })).toBeTruthy()
    const lines = [1, 2, 3].map(n => screen.getByRole('textbox', { name: `Goal ${n}` }))
    expect(lines).toHaveLength(3)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByRole('img', { name: 'No goals yet' })).toBeTruthy()
  })

  it('saves what was typed into last week’s review, which it makes', () => {
    const { onSave } = card(undefined)
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal 1' }), { target: { value: 'Book the electrician' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal 3' }), { target: { value: '  Date night  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0]
    expect(saved).toMatchObject({ kind: 'review', period: 'week', key: LAST_WEEK, top: ['Book the electrician', 'Date night'], topDone: [false, false] })
    expect(saved.summary).toBeUndefined()
    expect(saved.draftedAt).toBeUndefined()
  })

  it('moves to the next line on Return, as a list of three should', () => {
    card(undefined)
    const [one, two] = [screen.getByRole('textbox', { name: 'Goal 1' }), screen.getByRole('textbox', { name: 'Goal 2' })]
    one.focus()
    fireEvent.keyDown(one, { key: 'Enter' })
    expect(document.activeElement).toBe(two)
  })

  it('offers Plan next week beside them when Home asks it to (a Sunday)', () => {
    const plan = vi.fn()
    card(undefined, { onPlanWeek: plan })
    fireEvent.click(screen.getByRole('button', { name: 'Plan next week' }))
    expect(plan).toHaveBeenCalledTimes(1)
  })
})

describe('with the week’s 3 set', () => {
  const set = (topDone: boolean[] = [true, false, false]) => last({ top: ['Book the electrician', 'Finish the garage shelves', 'Date night Friday'], topDone })

  it('shows them to tick, the ring counting, a struck line for each done, and → task for the rest', () => {
    const { onMakeTask } = card(set(), { focusTitles: new Set(['date night friday']) })
    expect(said()).toBe('Tick them off as the week goes')
    // never a second role="status" on Home: that is the toast's, which tests and VoiceOver find by it
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('heading', { name: 'This week’s 3' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '1 of 3 done' })).toBeTruthy()
    const done = screen.getByRole('checkbox', { name: 'Mark “Book the electrician” not done' }) as HTMLInputElement
    expect(done.checked).toBe(true)
    expect(done.closest('li')?.className).toContain('done')
    expect(screen.queryByRole('button', { name: 'Make “Book the electrician” a task' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Make “Finish the garage shelves” a task' }))
    expect(onMakeTask).toHaveBeenCalledWith('Finish the garage shelves')
    // the goal that is one of today's focus tasks says so
    expect(within(screen.getByText('Date night Friday').closest('li')!).getByText('Today’s focus')).toBeTruthy()
  })

  it('ticks a goal from anywhere on its line', () => {
    const { onSave } = card(set())
    fireEvent.click(screen.getByText('Finish the garage shelves'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0].topDone).toEqual([true, true, false])
    expect(buzz.haptic).not.toHaveBeenCalled()
  })

  it('opens the same lines on Edit, and puts them back on Cancel', () => {
    const { onSave } = card(set())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect((screen.getByRole('textbox', { name: 'Goal 2' }) as HTMLInputElement).value).toBe('Finish the garage shelves')
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal 2' }), { target: { value: 'Clear the garage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('Finish the garage shelves')).toBeTruthy()
  })

  it('saves an edit onto last week’s record, the kept goal keeping its tick', () => {
    const { onSave } = card(set())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal 2' }), { target: { value: 'Clear the garage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave.mock.calls[0][0]).toMatchObject({ id: 'r-last', key: LAST_WEEK, top: ['Book the electrician', 'Clear the garage', 'Date night Friday'], topDone: [true, false, false] })
  })
})

describe('the cheer on all 3', () => {
  const two = () => last({ top: ['Book the electrician', 'Finish the garage shelves', 'Date night Friday'], topDone: [true, true, false] })

  it('bursts, says “All 3 done” and buzzes once, on the tick that finishes them', () => {
    const { view, onSave } = card(two())
    expect(document.querySelector('.goals-burst')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark “Date night Friday” done' }))
    expect(buzz.haptic).toHaveBeenCalledTimes(1)
    expect(buzz.haptic).toHaveBeenCalledWith('success')
    expect(document.querySelectorAll('.goals-burst > i').length).toBeGreaterThan(0)
    // the shell saves the tick, and the card draws the week done
    view.rerender(<WeekGoals reviews={[onSave.mock.calls[0][0]]} record={onSave.mock.calls[0][0]} noon={NOON} focusTitles={new Set()} onSave={onSave} onMakeTask={noop} />)
    expect(said()).toBe('All 3 done')
    expect(screen.getByRole('img', { name: '3 of 3 done' })).toBeTruthy()
  })

  it('never cheers as the card draws, even with all 3 done', () => {
    card(last({ top: ['a', 'b', 'c'], topDone: [true, true, true] }))
    expect(said()).toBe('All 3 done')
    expect(document.querySelector('.goals-burst')).toBeNull()
    expect(buzz.haptic).not.toHaveBeenCalled()
  })

  it('under Reduce Motion, says it and buzzes, with no burst', () => {
    motion(true)
    card(two())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark “Date night Friday” done' }))
    expect(buzz.haptic).toHaveBeenCalledWith('success')
    expect(document.querySelector('.goals-burst')).toBeNull()
  })

  it('does not cheer an untick, nor a tick that leaves one to go', () => {
    card(last({ top: ['a', 'b', 'c'], topDone: [true, false, false] }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark “b” done' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark “a” not done' }))
    expect(buzz.haptic).not.toHaveBeenCalled()
    expect(document.querySelector('.goals-burst')).toBeNull()
  })
})
