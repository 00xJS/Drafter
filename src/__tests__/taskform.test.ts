import { describe, expect, it } from 'vitest'
import { FormPatch, TaskForm, formReducer, formValues, initForm, isDirty, isEmpty, mergeOnto, money, versionNote, versionRows } from '../taskform'
import type { Task } from '../types'
import { toLocalInput } from '../utils'

/*
 * The task editor's save rules, out of the component: what a save writes, what
 * counts as an unsaved change, and what a saved task never lets the form
 * overwrite.
 */

const OPENED = '2026-09-01T09:00:00.000Z'
const LATER = '2026-09-01T10:00:00.000Z'

const task = (over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 't1',
  title: 'Fix the gate',
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: OPENED,
  updatedAt: OPENED,
  tags: [],
  ...over,
})
const edit = (form: TaskForm, patch: FormPatch) => formReducer(form, { type: 'set', patch })

describe('a save writes only what was changed, onto the freshest copy', () => {
  it('keeps a concurrent edit to a field the editor did not touch', () => {
    const base = task({ notes: 'measure first' })
    const form = edit(initForm(base), { title: 'Fix the side gate' })
    // while the editor was open, another device changed the notes and the priority
    const current: Task = { ...base, notes: 'bought hinges', priority: 'high', updatedAt: LATER }
    const next = mergeOnto(current, form, base, true)
    expect(next.title).toBe('Fix the side gate')
    expect(next.notes).toBe('bought hinges')
    expect(next.priority).toBe('high')
    expect(Date.parse(next.updatedAt)).toBeGreaterThan(Date.parse(LATER))
  })

  it('stamps completedAt when the task is done, and clears it for any other status', () => {
    const open = task()
    const done = mergeOnto(open, edit(initForm(open), { status: 'done' }), open, true)
    expect(Number.isNaN(Date.parse(done.completedAt ?? ''))).toBe(false)

    const finished = task({ status: 'done', completedAt: '2026-08-30T12:00:00.000Z' })
    expect(mergeOnto(finished, edit(initForm(finished), { title: 'Gate fixed' }), finished, true).completedAt).toBe('2026-08-30T12:00:00.000Z')
    for (const status of ['wishlist', 'todo', 'doing', 'blocked', 'canceled'] as const) {
      expect(mergeOnto(finished, edit(initForm(finished), { status }), finished, true).completedAt, status).toBeUndefined()
    }
  })

  it('trims a bill payee, and drops one that is only spaces', () => {
    const base = task()
    expect(formValues(edit(initForm(base), { bill: { kind: 'card', payee: '  Amex  ', autopay: true } }), base, false).bill).toEqual({ kind: 'card', payee: 'Amex', autopay: true })
    expect(formValues(edit(initForm(base), { bill: { kind: 'bill', payee: '   ' } }), base, false).bill).toEqual({ kind: 'bill' })
  })

  it('strips a leading # from tags and drops blank ones', () => {
    const base = task()
    expect(formValues(edit(initForm(base), { tags: '#home, errand, , #garden ,' }), base, true).tags).toEqual(['home', 'errand', 'garden'])
  })

  it('reads money as it is typed, and nothing for blanks, negatives or words', () => {
    expect(money('£1,234.50')).toBe(1234.5)
    expect(money('0')).toBe(0)
    expect(money('')).toBeUndefined()
    expect(money('-5')).toBeUndefined()
    expect(money('ten')).toBeUndefined()
  })
})

describe('what counts as empty and as unsaved', () => {
  it('counts a blank new task as empty, and anything in it as not', () => {
    const base = task({ title: '' })
    const form = initForm(base)
    expect(isEmpty(mergeOnto(base, form, base, false))).toBe(true)
    // spaces alone are still nothing
    expect(isEmpty(mergeOnto(base, edit(form, { title: '   ', notes: '  ' }), base, false))).toBe(true)
    expect(isEmpty(mergeOnto(base, edit(form, { title: 'Call mum' }), base, false))).toBe(false)
    expect(isEmpty(mergeOnto(base, edit(form, { tags: '#home' }), base, false))).toBe(false)
    expect(isEmpty(mergeOnto(base, formReducer(form, { type: 'addCheck', items: [{ id: 'c1', text: 'Ring', done: false }] }), base, false))).toBe(false)
  })

  it('finds nothing to save in a form nobody touched', () => {
    const base = task({ dueAt: '2026-09-14T08:00:00.000Z', tags: ['home'], estimateCost: 40, bill: { kind: 'bill', payee: 'British Gas' }, recurrence: { freq: 'monthly' } })
    expect(isDirty(initForm(base), base, true)).toBe(false)
    expect(isDirty(edit(initForm(base), { estimateCost: '41' }), base, true)).toBe(true)
  })
})

describe('on a saved task the checklist and comments are written as they happen, never by the save', () => {
  it('never overwrites them with the form copy', () => {
    const base = task({ checklist: [{ id: 'a', text: 'Buy hinges', done: false }], comments: [{ id: 'm1', body: 'Called Dave', createdAt: OPENED }] })
    let form = formReducer(initForm(base), { type: 'addCheck', items: [{ id: 'b', text: 'Oil them', done: false }] })
    form = edit(form, f => ({ title: 'Fix the side gate', comments: f.comments.filter(c => c.id !== 'm1') }))
    // meanwhile a tick landed from the phone, and a bot added a comment
    const current: Task = {
      ...base,
      checklist: [{ id: 'a', text: 'Buy hinges', done: true }],
      comments: [...base.comments!, { id: 'm2', body: 'Parts ordered', createdAt: LATER }],
      updatedAt: LATER,
    }
    const next = mergeOnto(current, form, base, true)
    expect(next.title).toBe('Fix the side gate')
    expect(next.checklist).toEqual(current.checklist)
    expect(next.comments).toEqual(current.comments)
  })

  it('does not count a tick as an unsaved change there, while a new task saves its checklist', () => {
    const base = task({ checklist: [{ id: 'a', text: 'Buy hinges', done: false }] })
    const ticked = edit(initForm(base), f => ({ checklist: f.checklist.map(c => ({ ...c, done: true })) }))
    expect(isDirty(ticked, base, true)).toBe(false)
    expect(isDirty(ticked, base, false)).toBe(true)
  })

  it("saves a new task's steps trimmed, without blank ones", () => {
    const base = task({ title: '' })
    const form = formReducer(initForm(base), {
      type: 'addCheck',
      items: [
        { id: 'a', text: '  Ring the council ', done: false },
        { id: 'b', text: '   ', done: false },
      ],
    })
    expect(formValues(form, base, false).checklist).toEqual([{ id: 'a', text: 'Ring the council', done: false }])
  })
})

describe('applying a captured sentence', () => {
  it('matches project and people by name, merges tags, and sets the date and repeat', () => {
    const base = task({ title: 'dentist tomorrow 3pm' })
    const form = edit(initForm(base), { tags: 'health', peopleIds: ['p1'] })
    const next = formReducer(form, {
      type: 'applyCapture',
      capture: { title: 'Dentist', dueAt: '2026-09-13T14:00:00.000Z', priority: 'high', projectName: 'home', peopleNames: ['Mum', 'Nobody'], tags: ['health', 'teeth'], recurrence: 'monthly' },
      projects: [{ id: 'pr1', name: 'Home' }],
      people: [
        { id: 'p1', name: 'Dad' },
        { id: 'p2', name: 'mum' },
      ],
    })
    expect(next).toMatchObject({ title: 'Dentist', priority: 'high', projectId: 'pr1', peopleIds: ['p1', 'p2'], tags: 'health, teeth', freq: 'monthly' })
    expect(next.dueAt).toBe(toLocalInput('2026-09-13T14:00:00.000Z'))
  })

  it('leaves alone whatever the sentence did not mention', () => {
    const base = task({ title: 'Gate', projectId: 'pr9', priority: 'low' })
    const form = initForm(base)
    const next = formReducer(form, { type: 'applyCapture', capture: { title: '', projectName: 'Unknown' }, projects: [], people: [] })
    expect(next).toEqual(form)
  })
})

describe('the Versions list', () => {
  const rows = [
    { replaced_at: '2026-09-02T10:00:00.000Z', updated_at: '2026-09-02T09:59:00.000Z', data: task({ title: 'Mine' }), reason: 'lost' },
    // a database from before v3.11 has no reason column at all
    { replaced_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T09:00:00.000Z', data: task({ title: 'Older' }) },
    { replaced_at: '2026-08-31T10:00:00.000Z', updated_at: '2026-08-31T09:00:00.000Z', data: null },
  ]

  it('keeps the reason a row carries, reads a missing one as none, and skips rows without data', () => {
    const versions = versionRows(rows)
    expect(versions.map(v => v.data.title)).toEqual(['Mine', 'Older'])
    expect(versions.map(v => v.reason)).toEqual(['lost', null])
    expect(versionRows(null)).toEqual([])
  })

  it('labels an edit that lost to a newer one, and only that', () => {
    const [lost, older] = versionRows(rows)
    expect(versionNote(lost)).toBe('Lost to a newer edit · ')
    expect(versionNote(older)).toBe('')
    expect(versionNote({ ...older, reason: 'stale' })).toBe('')
  })
})
