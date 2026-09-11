import { describe, it, expect } from 'vitest'
import { Routine } from '../types'
import { isStepDone, progressOn, stepsFromText, stepsToText, tickKey, toggleStep, whichToShow } from '../routines'
import { sanitizeItem, sanitizeRoutine } from '../schema'

function routine(over: Partial<Routine> = {}): Routine {
  return {
    kind: 'routine',
    id: 'r1',
    name: 'Morning start',
    when: 'morning',
    steps: [
      { id: 'a', text: 'Stretch' },
      { id: 'b', text: 'Water' },
    ],
    ticks: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}
const TODAY = '2026-09-10'
const YESTERDAY = '2026-09-09'
const NOW = '2026-09-10T08:00:00.000Z'

describe('tick keys', () => {
  it('join the day and the step', () => {
    expect(tickKey(TODAY, 'a')).toBe('2026-09-10|a')
  })
})

describe('ticking a step', () => {
  it('adds, removes, keeps the list sorted and unique, and stamps the record', () => {
    let r = routine()
    r = toggleStep(r, TODAY, 'b', NOW)
    r = toggleStep(r, TODAY, 'a', NOW)
    expect(r.ticks).toEqual(['2026-09-10|a', '2026-09-10|b'])
    expect(r.updatedAt).toBe(NOW)
    expect(isStepDone(r, TODAY, 'a')).toBe(true)
    r = toggleStep(r, TODAY, 'a', NOW)
    expect(r.ticks).toEqual(['2026-09-10|b'])
    expect(isStepDone(r, TODAY, 'a')).toBe(false)
  })
  it("yesterday's ticks do not count today, so a new day starts fresh", () => {
    const r = toggleStep(toggleStep(routine(), YESTERDAY, 'a', NOW), YESTERDAY, 'b', NOW)
    expect(progressOn(r, YESTERDAY)).toEqual({ done: 2, total: 2 })
    expect(isStepDone(r, TODAY, 'a')).toBe(false)
    expect(progressOn(r, TODAY)).toEqual({ done: 0, total: 2 })
  })
})

describe('progress', () => {
  it("counts only today's ticks against the current steps", () => {
    const r = routine({ ticks: ['2026-09-09|a', '2026-09-10|a', '2026-09-10|gone'] }) // 'gone' is an orphan
    expect(progressOn(r, TODAY)).toEqual({ done: 1, total: 2 })
  })
  it('is 0/0 with no steps', () => {
    expect(progressOn(routine({ steps: [] }), TODAY)).toEqual({ done: 0, total: 0 })
  })
})

describe('which routines to show', () => {
  const at = (h: number) => [...whichToShow(h)].sort()
  it('morning before noon, evening from five, anytime always', () => {
    expect(at(0)).toEqual(['anytime', 'morning'])
    expect(at(7)).toEqual(['anytime', 'morning'])
    expect(at(12)).toEqual(['anytime'])
    expect(at(16)).toEqual(['anytime'])
    expect(at(17)).toEqual(['anytime', 'evening'])
    expect(at(23)).toEqual(['anytime', 'evening'])
  })
})

describe('steps from the one-per-line editor', () => {
  const counter = () => {
    let n = 0
    return () => `s${++n}`
  }
  it('mints an id per non-blank line', () => {
    expect(stepsFromText('Stretch\n\n  Water  \n', [], counter())).toEqual([
      { id: 's1', text: 'Stretch' },
      { id: 's2', text: 'Water' },
    ])
  })
  it('keeps the id of an unchanged line even when it moves, and mints for a new one', () => {
    const prev = routine().steps
    expect(stepsFromText('Water\nCoffee\nStretch', prev, counter())).toEqual([
      { id: 'b', text: 'Water' },
      { id: 's1', text: 'Coffee' },
      { id: 'a', text: 'Stretch' },
    ])
  })
  it('does not reuse one previous id for two identical lines', () => {
    expect(stepsFromText('Water\nWater', routine().steps, counter())).toEqual([
      { id: 'b', text: 'Water' },
      { id: 's1', text: 'Water' },
    ])
  })
  it('round-trips through the text form', () => {
    expect(stepsToText(routine().steps)).toBe('Stretch\nWater')
  })
})

describe('sanitizeRoutine', () => {
  it('needs an id', () => {
    expect(sanitizeRoutine({ kind: 'routine', name: 'x' })).toBeNull()
  })
  it('drops malformed steps and de-dupes by step id', () => {
    const r = sanitizeRoutine({
      kind: 'routine',
      id: 'r9',
      name: 'x',
      when: 'evening',
      steps: [{ id: 'a', text: 'Teeth' }, { id: 'b' }, { text: 'no id' }, { id: 'a', text: 'dupe' }, { id: 'c', text: '   ' }, 'junk', null],
    })
    expect(r).not.toBeNull()
    expect(r!.when).toBe('evening')
    expect(r!.steps).toEqual([{ id: 'a', text: 'Teeth' }])
  })
  it('de-dupes and sorts ticks and drops anything not day|step', () => {
    const r = sanitizeRoutine({
      kind: 'routine',
      id: 'r9',
      ticks: ['2026-09-10|b', '2026-09-10|a', '2026-09-10|a', 'nope', '2026-09-10', 42, null],
    })
    expect(r!.ticks).toEqual(['2026-09-10|a', '2026-09-10|b'])
  })
  it('falls back to anytime for an unknown when, and to empty lists', () => {
    const r = sanitizeRoutine({ kind: 'routine', id: 'r9', when: 'lunch' })
    expect(r!.when).toBe('anytime')
    expect(r!.name).toBe('')
    expect(r!.steps).toEqual([])
    expect(r!.ticks).toEqual([])
  })
  it('a purge tombstone survives sanitizeItem with its deletedAt intact', () => {
    const t = sanitizeItem({ kind: 'routine', id: 'x', deletedAt: '2026-09-01T00:00:00.000Z', purged: true, createdAt: NOW, updatedAt: NOW })
    expect(t).toMatchObject({ kind: 'routine', id: 'x', deletedAt: '2026-09-01T00:00:00.000Z', purged: true })
  })
})
