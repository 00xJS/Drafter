import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalView } from '../components/Journal'
import { dayLabel, journalWeek, newEntry } from '../journal'
import type { JournalEntry } from '../types'
import { button, elements, settled, textOf } from './rendered'

// You could write today, and you could edit a day you had already written. A
// day you skipped had neither: the page lists days that have an entry, so
// Tuesday with nothing on it had no row, and there was nothing to tap. The week
// strip gives all seven a row, and the date field gives any day older one.

const TODAY = '2026-09-16' // a Wednesday; its week runs Sunday 13th → Saturday 19th

const entry = (date: string, body: string, mood?: JournalEntry['mood']): JournalEntry => newEntry(date, body, mood)

// The page asks matchMedia for its phone layout and schedules the scroll to a
// day it opens; node has neither. The scroll is a no-op here, which is the
// point — what is under test is which rows exist, not where the page ends up.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`))
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    setTimeout: () => 0,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const view = (entries: JournalEntry[], act?: (tree: ReturnType<typeof settled>) => void) =>
  settled(
    JournalView,
    { entries, people: [], onSave: vi.fn(), onDelete: vi.fn() },
    act as (tree: unknown) => void,
  )

describe('journalWeek', () => {
  it('is the whole week, Sunday first, written or not', () => {
    const week = journalWeek([entry('2026-09-14', 'Monday', 4)], TODAY)
    expect(week.map(d => d.date)).toEqual([
      '2026-09-13',
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
    ])
    expect(week.find(d => d.date === '2026-09-14')).toMatchObject({ written: true, mood: 4, ahead: false })
    expect(week.find(d => d.date === '2026-09-15')).toMatchObject({ written: false, ahead: false })
  })

  it('marks the days that have not come yet', () => {
    expect(journalWeek([], TODAY).filter(d => d.ahead).map(d => d.date)).toEqual(['2026-09-17', '2026-09-18', '2026-09-19'])
    expect(journalWeek([], TODAY).find(d => d.date === TODAY)?.ahead).toBe(false)
  })

  it('ignores a deleted entry, as the rest of the page does', () => {
    const gone: JournalEntry = { ...entry('2026-09-14', 'Monday'), deletedAt: new Date().toISOString() }
    expect(journalWeek([gone], TODAY).find(d => d.date === '2026-09-14')?.written).toBe(false)
  })
})

describe('the week strip', () => {
  // the labels are the reader's locale, so the test asks for them the same way the page writes them
  const dayButton = (tree: ReturnType<typeof settled>, date: string) => {
    const label = dayLabel(date)
    const hit = elements(tree).find(e => e.type === 'button' && String(e.props['aria-label'] ?? '').startsWith(label))
    if (!hit) throw new Error(`no day button for ${label}`)
    return hit
  }
  /** How a row's date reads in the archive below. */
  const rowDate = (date: string) => dayLabel(date, { day: 'numeric', month: 'short', year: 'numeric' })
  const rowDay = (date: string) => dayLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })

  it('offers every day of the week, and says which have nothing written', () => {
    const tree = view([entry('2026-09-14', 'Monday', 4)])
    expect(String(dayButton(tree, '2026-09-14').props['aria-label'])).toContain('Good')
    expect(String(dayButton(tree, '2026-09-15').props['aria-label'])).toContain('nothing written')
  })

  it('will not let you write a day that has not happened', () => {
    const tree = view([])
    expect(dayButton(tree, '2026-09-17').props.disabled).toBe(true)
    expect(dayButton(tree, '2026-09-15').props.disabled).toBeFalsy()
  })

  it('gives a skipped day a row to be written in, which it did not have before', () => {
    const before = view([entry('2026-09-14', 'Monday')])
    // the archive lists Monday and nothing else: Sunday was unreachable
    expect(textOf(before)).not.toContain(rowDay('2026-09-13'))

    const after = view([entry('2026-09-14', 'Monday')], tree => (dayButton(tree, '2026-09-13').props.onClick as () => void)())
    expect(textOf(after)).toContain(rowDay('2026-09-13'))
    // and it opens straight into the editor, so the words go where the tap meant
    expect(() => button(after, 'Done')).not.toThrow()
  })

  it('hands the editor the day that was tapped, not today', () => {
    const after = view([entry('2026-09-14', 'Monday')], t => (dayButton(t, '2026-09-13').props.onClick as () => void)())
    const dates = elements(after)
      .filter(e => typeof e.type === 'function' && (e.type as { name?: string }).name === 'JournalEditor')
      .map(e => e.props.date)
    expect(dates).toContain('2026-09-13')
  })

  it('opens any older day from the date field', () => {
    const tree = view([], t => {
      const field = elements(t).find(e => e.type === 'input' && e.props.type === 'date')
      if (!field) throw new Error('no date field')
      ;(field.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '2026-08-02' } })
    })
    expect(textOf(tree)).toContain(rowDate('2026-08-02'))
  })

  it('clears the date field after it jumps, so nothing is left sitting in it', () => {
    const target = { value: '2026-08-02' }
    view([], t => {
      const field = elements(t).find(e => e.type === 'input' && e.props.type === 'date')
      ;(field?.props.onChange as (e: { target: { value: string } }) => void)({ target })
    })
    expect(target.value).toBe('')
  })

  it('takes today to its own card rather than giving it a second row', () => {
    const tree = view([entry('2026-09-14', 'Monday')], t => (dayButton(t, '2026-09-16').props.onClick as () => void)())
    // "Today" is the card's own heading; the archive below never repeats it
    expect(textOf(tree).match(/Today/g)?.length).toBe(1)
  })

  it('a day written after it was opened blank keeps one row, not two', () => {
    const entries = [entry('2026-09-14', 'Monday'), entry('2026-09-13', 'Sunday, written later')]
    const tree = view(entries, t => (dayButton(t, '2026-09-13').props.onClick as () => void)())
    expect(textOf(tree).split(rowDay('2026-09-13')).length - 1).toBe(1)
  })
})
