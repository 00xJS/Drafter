import { describe, expect, it } from 'vitest'
import {
  appendEntry,
  entriesBetween,
  entriesOn,
  entryOn,
  journalId,
  journalLines,
  mentions,
  moodAverage,
  newEntry,
  peopleNameMap,
  shiftDayKey,
  streak,
} from '../../shared/journal.mjs'
import { entriesInRange, moodIndexAt, moodSeries, moodWeeksFor } from '../journal'
import { weekRange } from '../review'
import { sanitizeItem, sanitizeJournal } from '../schema'
import { parseLink } from '../links'
import { JournalEntry } from '../types'

function entry(over: Partial<JournalEntry> & { date: string }): JournalEntry {
  return {
    kind: 'journal',
    id: `journal~${over.date}~abc`,
    body: 'wrote something',
    createdAt: '2026-09-01T20:00:00.000Z',
    updatedAt: '2026-09-01T20:00:00.000Z',
    ...over,
  }
}

describe('journal ids and lookup', () => {
  it('puts the day in the id with a random suffix so two writers never collide', () => {
    const a = journalId('2026-09-08')
    const b = journalId('2026-09-08')
    expect(a.startsWith('journal~2026-09-08~')).toBe(true)
    expect(a).not.toBe(b)
    expect(journalId('2026-09-08', 'fixed')).toBe('journal~2026-09-08~fixed')
  })

  it('entryOn picks the most recently edited entry for a day and skips tombstones', () => {
    const older = entry({ date: '2026-09-08', id: 'a', updatedAt: '2026-09-08T08:00:00.000Z', body: 'morning' })
    const newer = entry({ date: '2026-09-08', id: 'b', updatedAt: '2026-09-08T21:00:00.000Z', body: 'evening' })
    const gone = entry({ date: '2026-09-08', id: 'c', updatedAt: '2026-09-08T23:00:00.000Z', deletedAt: '2026-09-09T00:00:00.000Z' })
    expect(entryOn([older, gone, newer], '2026-09-08')?.id).toBe('b')
    expect(entriesOn([older, gone, newer], '2026-09-08').map(e => e.id)).toEqual(['b', 'a'])
    expect(entryOn([older], '2026-09-09')).toBeNull()
  })

  it('entriesBetween is end-exclusive and newest day first', () => {
    const list = [entry({ date: '2026-09-06' }), entry({ date: '2026-09-07' }), entry({ date: '2026-09-13' }), entry({ date: '2026-09-05' })]
    expect(entriesBetween(list, '2026-09-06', '2026-09-13').map(e => e.date)).toEqual(['2026-09-07', '2026-09-06'])
  })

  it('entriesInRange follows the Sunday-start review week', () => {
    const week = weekRange(new Date(2026, 8, 9, 12)) // Wed 9 Sep → Sun 6 … Sat 12
    const list = [entry({ date: '2026-09-05' }), entry({ date: '2026-09-06' }), entry({ date: '2026-09-12' }), entry({ date: '2026-09-13' })]
    expect(entriesInRange(list, week).map(e => e.date)).toEqual(['2026-09-12', '2026-09-06'])
  })
})

describe('appendEntry', () => {
  it('creates the day when it has no entry', () => {
    const e = appendEntry(null, '2026-09-08', '  Walked the dog  ', { now: '2026-09-08T18:00:00.000Z', rand: 'r1' })
    expect(e).toMatchObject({ kind: 'journal', id: 'journal~2026-09-08~r1', date: '2026-09-08', body: 'Walked the dog', createdAt: '2026-09-08T18:00:00.000Z' })
    expect(e.mood).toBeUndefined()
  })

  it('appends a new line, keeps every earlier word, and bumps the stamp', () => {
    const existing = entry({ date: '2026-09-08', body: 'Slow morning.  ', updatedAt: '2026-09-08T09:00:00.000Z' })
    const next = appendEntry(existing, '2026-09-08', 'Good dinner with Mum', { mood: 4 })
    expect(next.body).toBe('Slow morning.\nGood dinner with Mum')
    expect(next.mood).toBe(4)
    expect(next.id).toBe(existing.id)
    expect(next.updatedAt > existing.updatedAt).toBe(true)
  })

  it('does not start a blank entry with a newline', () => {
    const existing = entry({ date: '2026-09-08', body: '   ', mood: 3 })
    expect(appendEntry(existing, '2026-09-08', 'First line').body).toBe('First line')
  })

  it('keeps the people already on the day and only ever adds to them', () => {
    const existing = entry({ date: '2026-09-08', peopleIds: ['mum', 'dad'] })
    expect(appendEntry(existing, '2026-09-08', 'Tea').peopleIds).toEqual(['mum', 'dad'])
    expect(appendEntry(existing, '2026-09-08', 'Tea', { peopleIds: ['dad', 'sam', ''] }).peopleIds).toEqual(['mum', 'dad', 'sam'])
    // an agent tagging nobody does not clear the day
    expect(appendEntry(existing, '2026-09-08', 'Tea', { peopleIds: [] }).peopleIds).toEqual(['mum', 'dad'])
    // a fresh day takes the people given; an empty list is stored as nothing at all
    expect(appendEntry(null, '2026-09-09', 'Walk', { peopleIds: ['sam', 'sam'] }).peopleIds).toEqual(['sam'])
    expect(appendEntry(null, '2026-09-09', 'Walk', { peopleIds: [] })).not.toHaveProperty('peopleIds')
    expect(newEntry('2026-09-09', 'Walk', undefined, undefined, undefined, [])).not.toHaveProperty('peopleIds')
  })
})

describe('mentions', () => {
  it('lists the days about a person, newest day then newest edit, ignoring tombstones and other people', () => {
    const list = [
      entry({ date: '2026-09-06', id: 'a', peopleIds: ['mum'], updatedAt: '2026-09-06T20:00:00.000Z' }),
      entry({ date: '2026-09-08', id: 'b', peopleIds: ['dad', 'mum'], updatedAt: '2026-09-08T09:00:00.000Z' }),
      entry({ date: '2026-09-08', id: 'c', peopleIds: ['mum'], updatedAt: '2026-09-08T21:00:00.000Z' }),
      entry({ date: '2026-09-07', id: 'd', peopleIds: ['dad'] }),
      entry({ date: '2026-09-09', id: 'e', peopleIds: ['mum'], deletedAt: '2026-09-09T10:00:00.000Z' }),
      entry({ date: '2026-09-05', id: 'f' }),
    ]
    expect(mentions(list, 'mum').map(e => e.id)).toEqual(['c', 'b', 'a'])
    expect(mentions(list, 'dad').map(e => e.id)).toEqual(['b', 'd'])
    expect(mentions(list, 'nobody')).toEqual([])
    expect(mentions(list, '')).toEqual([])
  })
})

describe('streak and mood', () => {
  it('counts consecutive days back from today, or from yesterday when today is blank', () => {
    const list = [entry({ date: '2026-09-08' }), entry({ date: '2026-09-07' }), entry({ date: '2026-09-06' }), entry({ date: '2026-09-03' })]
    expect(streak(list, '2026-09-08')).toBe(3)
    expect(streak(list, '2026-09-09')).toBe(3)
    expect(streak(list, '2026-09-10')).toBe(0)
    expect(streak([], '2026-09-10')).toBe(0)
  })

  it('shiftDayKey crosses month ends without a timezone', () => {
    expect(shiftDayKey('2026-09-01', -1)).toBe('2026-08-31')
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('averages only the entries that carry a mood', () => {
    expect(moodAverage([entry({ date: '2026-09-08', mood: 5 }), entry({ date: '2026-09-07', mood: 2 }), entry({ date: '2026-09-06' })])).toBe(3.5)
    expect(moodAverage([entry({ date: '2026-09-06' })])).toBeUndefined()
  })

  it('journalLines reads forward in time and clips long days', () => {
    const lines = journalLines([entry({ date: '2026-09-08', body: 'b'.repeat(400), mood: 4 }), entry({ date: '2026-09-07', body: 'a' }), entry({ date: '2026-09-06', body: '  ' })], 5, 50)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('2026-09-07: a')
    expect(lines[1].startsWith('2026-09-08 (mood 4/5): bbbb')).toBe(true)
    expect(lines[1].length).toBeLessThan(80)
  })

  it('journalLines names the people a day was about when given a lookup', () => {
    const list = [
      entry({ date: '2026-09-08', body: 'Roast', mood: 4, peopleIds: ['mum', 'dad', 'gone'] }),
      entry({ date: '2026-09-07', body: 'Quiet', peopleIds: ['dad'] }),
      entry({ date: '2026-09-06', body: 'Alone' }),
    ]
    const byId = peopleNameMap([
      { kind: 'person', id: 'mum', name: 'Mum' },
      { kind: 'person', id: 'dad', name: 'Dad' },
      { kind: 'person', id: 'gone', name: 'Old friend', deletedAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(journalLines(list, 14, 220, byId)).toEqual(['2026-09-06: Alone', '2026-09-07 (with Dad): Quiet', '2026-09-08 (mood 4/5, with Mum, Dad): Roast'])
    // a plain object works too, and no lookup means no names
    expect(journalLines(list.slice(0, 1), 14, 220, { mum: 'Mum' })[0]).toBe('2026-09-08 (mood 4/5, with Mum): Roast')
    expect(journalLines(list.slice(0, 1))[0]).toBe('2026-09-08 (mood 4/5): Roast')
  })
})

describe('sanitizeJournal', () => {
  it('round-trips a valid entry and clamps a bad mood', () => {
    const good = sanitizeJournal(entry({ date: '2026-09-08', mood: 4, peopleIds: ['mum'] }))
    expect(good).toMatchObject({ kind: 'journal', date: '2026-09-08', mood: 4, peopleIds: ['mum'] })
    expect(sanitizeJournal({ ...entry({ date: '2026-09-08' }), mood: 9 })?.mood).toBeUndefined()
    expect(sanitizeJournal({ ...entry({ date: '2026-09-08' }), mood: '3' })?.mood).toBe(3)
  })

  it('rejects an entry without a calendar day, and sanitizeItem routes the kind', () => {
    expect(sanitizeJournal({ id: 'x', body: 'hi' })).toBeNull()
    expect(sanitizeItem(entry({ date: '2026-09-08' }))?.kind).toBe('journal')
    expect(sanitizeItem(newEntry('2026-09-08', 'via shared', 2))?.kind).toBe('journal')
  })
})

describe('journal deep links', () => {
  it('drafter://journal?text= appends to today and nothing else', () => {
    const p = parseLink(new URLSearchParams('text=Long+walk&title=Ignored'), { host: 'journal' })
    expect(p.journal).toBe('Long walk')
    expect(p.capture).toBeUndefined()
  })

  it('?journal= and ?tab=journal work on the web too', () => {
    const p = parseLink(new URLSearchParams('view=review&tab=journal&journal=Quiet+day'))
    expect(p.tab).toBe('journal')
    expect(p.journal).toBe('Quiet day')
    expect(parseLink(new URLSearchParams('journal=%20')).journal).toBeUndefined()
  })
})

describe('moodSeries', () => {
  const today = '2026-09-08' // a Tuesday

  it('covers exactly 84 days ending today, oldest first, in Sunday-start weeks', () => {
    const s = moodSeries([], 12, today)
    expect(s.days).toHaveLength(84)
    expect(s.days[0].date).toBe('2026-06-17')
    expect(s.days[83].date).toBe(today)
    expect(s.days.every(d => d.mood === undefined)).toBe(true)
    // the range starts mid-week and ends mid-week, so 13 weeks touch it
    expect(s.weekly).toHaveLength(13)
    expect(s.weekly[0].start).toBe('2026-06-14')
    expect(s.weekly[12].start).toBe('2026-09-06')
    expect(s.weekly.every(w => w.avg === undefined && w.count === 0)).toBe(true)
    expect(moodSeries([], 2, today).days).toHaveLength(14)
  })

  it('takes the newest entry per day, leaves days without a mood blank, and averages each week to one decimal', () => {
    const list = [
      entry({ date: '2026-09-06', id: 'old', mood: 1, updatedAt: '2026-09-06T08:00:00.000Z' }),
      entry({ date: '2026-09-06', id: 'new', mood: 4, updatedAt: '2026-09-06T21:00:00.000Z' }),
      entry({ date: '2026-09-07', mood: 5 }),
      entry({ date: '2026-09-08', mood: 2 }),
      entry({ date: '2026-09-05' }),
      entry({ date: '2026-09-04', mood: 3, deletedAt: '2026-09-04T22:00:00.000Z' }),
      entry({ date: '2026-06-16', mood: 5 }),
      entry({ date: '2026-06-17', mood: 3 }),
    ]
    const s = moodSeries(list, 12, today)
    const by = Object.fromEntries(s.days.map(d => [d.date, d.mood]))
    expect(by['2026-09-06']).toBe(4)
    expect(by['2026-09-07']).toBe(5)
    expect(by['2026-09-08']).toBe(2)
    expect(by['2026-09-05']).toBeUndefined()
    expect(by['2026-09-04']).toBeUndefined()
    expect(by['2026-06-17']).toBe(3)
    expect('2026-06-16' in by).toBe(false)
    const [first, ...rest] = s.weekly
    const last = rest[rest.length - 1]
    const before = rest[rest.length - 2]
    expect(last).toEqual({ start: '2026-09-06', avg: 3.7, count: 3 }) // (4 + 5 + 2) / 3
    expect(before.start).toBe('2026-08-30')
    expect(before.avg).toBeUndefined()
    expect(before.count).toBe(0)
    expect(first).toEqual({ start: '2026-06-14', avg: 3, count: 1 }) // the 16th is outside the range
  })
})

describe('mood chart on a phone', () => {
  it('shortens the range until a column is wide enough to see', () => {
    // 375pt: 375 - 24 (.content padding) = 351 for the card the chart sits in
    expect(moodWeeksFor(351)).toBe(6)
    expect(moodWeeksFor(479)).toBe(6)
    expect(moodWeeksFor(480)).toBe(12)
    expect(moodWeeksFor(1000)).toBe(12)
  })

  it('leaves a phone column thick enough to read, where twelve weeks was a 1.9px smear', () => {
    // the chart's own plot box at 375pt: 351 - 32 (.chart-card padding)
    const plot = 319
    const width = (weeks: number, right: number) => {
      const slot = (plot - 6 - right) / (weeks * 7)
      return { slot, bar: Math.max(1.5, Math.min(6, slot * 0.6)) }
    }
    expect(width(12, 46).bar).toBeLessThan(2) // what shipped
    const now = width(moodWeeksFor(351), 8) // six weeks, and the gutter spent on columns
    expect(now.bar).toBeGreaterThan(4)
    // and the month labels no longer collide: the first change has to clear 26px
    expect(now.slot * 4).toBeGreaterThan(26)
    expect(now.slot * 3).toBeLessThan(26)
  })

  it('maps a scrub across the chart onto a day, clamped at both ends', () => {
    const left = 6
    const slot = 7.4
    expect(moodIndexAt(left + 0.1, left, slot, 42)).toBe(0)
    expect(moodIndexAt(left + slot * 3.5, left, slot, 42)).toBe(3)
    // a finger dragged off either edge holds the end day rather than vanishing
    expect(moodIndexAt(-200, left, slot, 42)).toBe(0)
    expect(moodIndexAt(9999, left, slot, 42)).toBe(41)
    // a chart that has not been measured yet must not divide by zero
    expect(moodIndexAt(50, left, 0, 42)).toBe(0)
    expect(moodIndexAt(50, left, slot, 0)).toBe(0)
  })
})

describe('journal helpers', () => {
  it('peopleOf resolves live people in entry order and samePeople compares lists', async () => {
    const { peopleOf, samePeople, recentEntries, journalDays, relativeDayLabel } = await import('../journal')
    const mum = { kind: 'person' as const, id: 'mum', name: 'Mum', color: '#f00', group: 'family' as const, createdAt: 'x', updatedAt: 'x' }
    const dad = { ...mum, id: 'dad', name: 'Dad' }
    expect(peopleOf({ peopleIds: ['dad', 'ghost', 'mum'] }, [mum, dad]).map(p => p.id)).toEqual(['dad', 'mum'])
    expect(peopleOf({}, [mum])).toEqual([])
    expect(samePeople(['a', 'b'], ['a', 'b'])).toBe(true)
    // order matters: the editor compares drafts field by field, and a reordered list is a change
    expect(samePeople(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(samePeople(['a'], ['a', 'b'])).toBe(false)
    expect(samePeople(undefined, [])).toBe(true)
    const list = [entry({ date: '2026-09-08' }), entry({ date: '2026-09-01' }), entry({ date: '2026-08-31' }), entry({ date: '2026-09-08', id: 'dup' })]
    expect(recentEntries(list, 7, '2026-09-08').map(e => e.date)).toEqual(['2026-09-08', '2026-09-08'])
    expect(journalDays(list)).toEqual(['2026-09-08', '2026-09-01', '2026-08-31'])
    expect(relativeDayLabel('2026-09-08', '2026-09-08')).toBe('Today')
    expect(relativeDayLabel('2026-09-07', '2026-09-08')).toBe('Yesterday')
  })
})

describe('faceGroup', () => {
  it('draws every face while they fit and collapses the tail into a count once they do not', async () => {
    const { faceGroup } = await import('../journal')
    const who = ['mum', 'dad', 'kid', 'gran', 'dog']
    expect(faceGroup(who.slice(0, 3), 3)).toEqual({ shown: ['mum', 'dad', 'kid'], extra: 0 })
    expect(faceGroup(who, 3)).toEqual({ shown: ['mum', 'dad', 'kid'], extra: 2 })
    expect(faceGroup([], 3)).toEqual({ shown: [], extra: 0 })
    // the header still names the whole roster in its aria-label; only the drawing is capped
    expect(faceGroup(who, 3).shown.length + faceGroup(who, 3).extra).toBe(who.length)
    // a nonsense cap still leaves one face rather than an empty row of "+5"
    expect(faceGroup(who, 0)).toEqual({ shown: ['mum'], extra: 4 })
  })
})
