import { describe, expect, it } from 'vitest'
import { appendEntry, draftOf, entryOn, idSet, mergeDraft, newEntry, sameDraft, samePeople } from '../journal'
import type { JournalDraft } from '../journal'
import { newerStamp } from '../itemops'
import { JournalEntry } from '../types'

// Today's card and Shut down's "Today in a line" are two JournalEditors on
// one entry. What reconciles them is mergeDraft: the editor's effect hands it
// what the editor holds, what it last saw and the entry that just arrived.
// vitest runs in node with no DOM, so the editors are driven through it here.

const DAY = '2026-09-12'

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    kind: 'journal',
    id: `journal~${DAY}~abc`,
    date: DAY,
    body: '',
    createdAt: '2026-09-12T08:00:00.000Z',
    updatedAt: '2026-09-12T08:00:00.000Z',
    ...over,
  }
}

/** The same entry saved somewhere else: the change, under a newer stamp, the way every writer saves one. */
const savedElsewhere = (e: JournalEntry, change: Partial<JournalEntry>): JournalEntry => ({ ...e, ...change, updatedAt: newerStamp(e.updatedAt) })

describe('mergeDraft: the entry changing under an editor', () => {
  const was = entry({ body: 'Slow morning.' })
  const seen = draftOf(was)

  it('keeps the text typed here', () => {
    const typed = { ...seen, body: 'Slow morning. Then the park.' }
    // a face picked on another device lands mid-sentence: the words stay
    expect(mergeDraft(typed, seen, savedElsewhere(was, { mood: 4 }))).toEqual({ draft: { ...typed, mood: 4 }, carried: false })
    // and a rewrite made elsewhere does not replace them; the next save here wins.
    // It is longer than the words seen, and what runs past them is not a line to carry
    expect(mergeDraft(typed, seen, savedElsewhere(was, { body: 'A slow start to the day.' }))).toEqual({ draft: typed, carried: false })
  })

  it('carries a line appended elsewhere onto its own line after the text typed here', () => {
    const typed = { ...seen, body: 'Slow morning. Then the park.' }
    const r = mergeDraft(typed, seen, appendEntry(was, DAY, 'Walked the dog'))
    expect(r.draft.body).toBe('Slow morning. Then the park.\nWalked the dog')
    // it is only on screen so far: the editor has to save it
    expect(r.carried).toBe(true)
    // a newline left at the end here does not become a blank line between the two
    const trailing = mergeDraft({ ...seen, body: 'Slow morning.\nThen the park.\n' }, seen, appendEntry(was, DAY, 'Walked the dog'))
    expect(trailing.draft.body).toBe('Slow morning.\nThen the park.\nWalked the dog')
  })

  it('carries it when the words last seen ended in a space, which appendEntry trims before its line', () => {
    const s = draftOf(entry({ body: 'Slow morning. ' }))
    const r = mergeDraft({ ...s, body: 'Slow morning. Then the park.' }, s, appendEntry(entry({ body: 'Slow morning. ' }), DAY, 'Walked the dog'))
    expect(r).toEqual({ draft: { body: 'Slow morning. Then the park.\nWalked the dog', mood: undefined, peopleIds: [] }, carried: true })
  })

  it('still puts it on a line of its own when the day was blank, where appendEntry writes it bare', () => {
    const blank = draftOf(undefined)
    const r = mergeDraft({ ...blank, body: 'Quiet day' }, blank, appendEntry(undefined, DAY, 'Walked the dog'))
    expect(r).toEqual({ draft: { body: 'Quiet day\nWalked the dog', mood: undefined, peopleIds: [] }, carried: true })
  })

  it('does not carry a line the text here already has', () => {
    const typed = { ...seen, body: 'Slow morning.\nWalked the dog\nFed the cat' }
    expect(mergeDraft(typed, seen, appendEntry(was, DAY, 'Walked the dog'))).toEqual({ draft: typed, carried: false })
    expect(mergeDraft(typed, seen, appendEntry(was, DAY, 'Walked the dog\nFed the cat'))).toEqual({ draft: typed, carried: false })
  })

  it('carries a short line even when the text here happens to contain it', () => {
    // a substring check dropped "Gym" here, and the save that followed wrote the entry back without it
    const typed = { ...seen, body: 'Slow morning. Gymnastics with Sam.' }
    expect(mergeDraft(typed, seen, appendEntry(was, DAY, 'Gym'))).toEqual({
      draft: { body: 'Slow morning. Gymnastics with Sam.\nGym', mood: undefined, peopleIds: [] },
      carried: true,
    })
    // standing on a line of its own here it is already there, spaces at its ends or not
    const own = { ...seen, body: 'Slow morning.\n  Gym \nGymnastics with Sam.' }
    expect(mergeDraft(own, seen, appendEntry(was, DAY, 'Gym'))).toEqual({ draft: own, carried: false })
  })

  it('does not open the text with a blank line when every word here was cleared', () => {
    const r = mergeDraft({ ...seen, body: '' }, seen, appendEntry(was, DAY, 'Walked the dog'))
    expect(r).toEqual({ draft: { body: 'Walked the dog', mood: undefined, peopleIds: [] }, carried: true })
  })

  it('takes mood, people and the words from the entry when they were not touched here', () => {
    const start = entry({ body: 'Slow morning.', mood: 2 })
    const before = draftOf(start)
    const there = savedElsewhere(start, { mood: 4, peopleIds: ['mum', 'dad'] })
    // only the words were typed here
    expect(mergeDraft({ ...before, body: 'Slow morning. Better now.' }, before, there).draft).toEqual({
      body: 'Slow morning. Better now.',
      mood: 4,
      peopleIds: ['mum', 'dad'],
    })
    // only a face was picked here: the words and the people are the entry's
    const later = savedElsewhere(there, { body: 'Slow morning.\nLunch with Mum' })
    expect(mergeDraft({ ...before, mood: 5 }, before, later).draft).toEqual({ body: 'Slow morning.\nLunch with Mum', mood: 5, peopleIds: ['mum', 'dad'] })
    // a face taken off elsewhere comes off here too
    expect(mergeDraft({ ...before, body: 'Slow morning. Better now.' }, before, savedElsewhere(start, { mood: undefined })).draft.mood).toBeUndefined()
  })

  it('never overwrites a field edited here', () => {
    const start = entry({ body: 'Slow morning.', mood: 3, peopleIds: ['mum'] })
    const before = draftOf(start)
    const there = savedElsewhere(start, { body: 'A slow start, then rain.', mood: 5, peopleIds: ['dad'] })
    // all three changed in both places: this editor keeps all three of its own
    const here: JournalDraft = { body: 'Slow morning, long lunch.', mood: 2, peopleIds: ['mum', 'sam'] }
    expect(mergeDraft(here, before, there)).toEqual({ draft: here, carried: false })
    // a face taken off here stays off, while the fields left alone follow the entry
    expect(mergeDraft({ ...before, mood: undefined }, before, there).draft).toEqual({ body: 'A slow start, then rain.', mood: undefined, peopleIds: ['dad'] })
  })

  it('is a no-op when the entry holds what the editor holds', () => {
    const start = entry({ body: 'Slow morning.', mood: 3, peopleIds: ['mum'] })
    const held = draftOf(start)
    // the editor's own save coming back, or the same entry read again by a sync under a newer stamp
    expect(mergeDraft(held, held, start)).toEqual({ draft: held, carried: false })
    expect(mergeDraft(held, held, savedElsewhere(start, {})).draft).toBe(held)
    // still typing when it comes back: nothing moves and nothing is carried
    const typing = { ...held, body: 'Slow morning. Then' }
    const r = mergeDraft(typing, held, start)
    expect(r.draft).toBe(typing)
    expect(r.carried).toBe(false)
    // the comparison under it: no people list is an empty one, but a reordered one is a change
    expect(sameDraft(draftOf(entry({ body: 'x' })), { body: 'x', peopleIds: [] })).toBe(true)
    expect(sameDraft({ ...held, peopleIds: ['mum', 'dad'] }, { ...held, peopleIds: ['dad', 'mum'] })).toBe(false)
  })

  it('starts blank once the day has no entry, typed into or not', () => {
    // deleted elsewhere, or Today's card rolling over to a new day
    expect(mergeDraft({ ...seen, body: 'Slow morning. Then' }, seen, undefined)).toEqual({ draft: { body: '', mood: undefined, peopleIds: [] }, carried: false })
  })
})

/**
 * One JournalEditor without its DOM: the draft on screen, and the entry and
 * draft it last saw. `receive` is its effect, run when the store hands it the
 * day's entry. `save` writes the way its commit does — into the entry it has,
 * or starting one when the day has none — and answers null when there is
 * nothing to write. (Neither editor clears the day here, so the delete path is
 * left out.)
 */
function editor(first?: JournalEntry) {
  let entry = first
  let created: JournalEntry | null = null
  let seen = draftOf(first)
  let draft = seen
  return {
    get draft() {
      return draft
    },
    type(change: Partial<JournalDraft>) {
      draft = { ...draft, ...change }
    },
    receive(next?: JournalEntry) {
      draft = mergeDraft(draft, seen, next).draft
      seen = draftOf(next)
      entry = next
      if (next) created = null
    },
    save(): JournalEntry | null {
      const ids = idSet(draft.peopleIds)
      const cur = entry ?? created
      if (!cur) {
        if (!draft.body.trim() && draft.mood === undefined && !ids) return null
        created = newEntry(DAY, draft.body, draft.mood, ids)
        seen = draft
        return created
      }
      if (cur.body === draft.body && cur.mood === draft.mood && samePeople(cur.peopleIds, ids)) return null
      const next: JournalEntry = { ...cur, body: draft.body, mood: draft.mood, peopleIds: ids, updatedAt: newerStamp(cur.updatedAt) }
      if (!entry) created = next
      seen = draft
      return next
    },
  }
}

/**
 * Today's card and Shut down open on one day, fed by one store the way the
 * app wires them: a save is store.upsert (replace by id), and every save hands
 * both editors the day's entry again, the one that wrote it included.
 */
function sameDay(start?: JournalEntry) {
  let rows: JournalEntry[] = start ? [start] : []
  const today = editor(start)
  const shutdown = editor(start)
  const save = (from: ReturnType<typeof editor>): boolean => {
    const e = from.save()
    if (!e) return false
    rows = rows.some(r => r.id === e.id) ? rows.map(r => (r.id === e.id ? e : r)) : [...rows, e]
    for (const ed of [today, shutdown]) ed.receive(entryOn(rows, DAY))
    return true
  }
  return {
    today,
    shutdown,
    save,
    get rows() {
      return rows
    },
  }
}

describe('two editors on one day: Today’s card and Shut down', () => {
  const start = entry({ body: 'Slow morning.' })

  it('saving in turn leaves one entry holding both edits', () => {
    const day = sameDay(start)
    // a line typed into Today's card, and Shut down opened before it saved (on
    // the phone a tap on the strip does not take the focus out of the box)
    day.today.type({ body: 'Slow morning.\nLunch with Mum' })
    // then a line and a face in Shut down
    day.shutdown.type({ body: 'Slow morning.\nEarly night.', mood: 4 })
    // Today's card saves first, its keystrokes came first; Shut down carries
    // that line under its own and writes the two back as one
    expect(day.save(day.today)).toBe(true)
    expect(day.shutdown.draft.body).toBe('Slow morning.\nEarly night.\nLunch with Mum')
    expect(day.save(day.shutdown)).toBe(true)
    expect(day.rows).toHaveLength(1)
    expect(day.rows[0]).toMatchObject({ id: start.id, body: 'Slow morning.\nEarly night.\nLunch with Mum', mood: 4 })
    // both show it, and neither has anything left to write
    expect(day.today.draft).toEqual(day.shutdown.draft)
    expect(day.save(day.today)).toBe(false)
    expect(day.save(day.shutdown)).toBe(false)
  })

  it('ends the same way when Shut down saves first', () => {
    const day = sameDay(start)
    day.today.type({ body: 'Slow morning.\nLunch with Mum' })
    day.shutdown.type({ body: 'Slow morning.\nEarly night.', mood: 4 })
    // closing the sheet writes its line at once; Today's card was still waiting to save
    expect(day.save(day.shutdown)).toBe(true)
    expect(day.save(day.today)).toBe(true)
    expect(day.rows).toHaveLength(1)
    expect(day.rows[0]).toMatchObject({ id: start.id, body: 'Slow morning.\nLunch with Mum\nEarly night.', mood: 4 })
    expect(day.shutdown.draft).toEqual(day.today.draft)
    expect(day.save(day.today)).toBe(false)
    expect(day.save(day.shutdown)).toBe(false)
  })

  it('takes a face and a person picked in one while the other is mid-sentence', () => {
    const day = sameDay(start)
    day.shutdown.type({ body: 'Slow morning. Then rain.' })
    day.today.type({ mood: 2, peopleIds: ['mum'] })
    day.save(day.today)
    day.save(day.shutdown)
    expect(day.rows).toHaveLength(1)
    expect(day.rows[0]).toMatchObject({ body: 'Slow morning. Then rain.', mood: 2, peopleIds: ['mum'] })
    expect(day.today.draft).toEqual(day.shutdown.draft)
  })

  it('starts one entry on a blank day, not one for each editor', () => {
    const day = sameDay()
    day.today.type({ body: 'Walked the dog' })
    day.shutdown.type({ body: 'Quiet evening', mood: 3 })
    // Today's card starts the day's entry; Shut down writes into that one
    day.save(day.today)
    day.save(day.shutdown)
    expect(day.rows).toHaveLength(1)
    expect(day.rows[0]).toMatchObject({ body: 'Quiet evening\nWalked the dog', mood: 3 })
    expect(day.today.draft).toEqual(day.shutdown.draft)
    expect(day.save(day.today)).toBe(false)
  })
})
