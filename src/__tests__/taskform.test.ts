import { describe, expect, it } from 'vitest'
import type { CapturedFields } from '../ai'
import { sanitizePerson } from '../schema'
import {
  FormPatch,
  TaskForm,
  appendOnce,
  cardUrl,
  commitStep,
  costsVisible,
  descriptionLinks,
  formReducer,
  formValues,
  initForm,
  isDirty,
  isEmpty,
  isGithubCardUrl,
  linkLabel,
  mergeOnto,
  money,
  newPerson,
  peopleSearch,
  pendingRenames,
  relinkGithub,
  unlinkGithub,
  urlsIn,
  versionNote,
  versionRows,
  withoutUrl,
} from '../taskform'
import type { ChecklistItem, Person, Task } from '../types'
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
const addSteps = (form: TaskForm, items: ChecklistItem[]) => formReducer(form, { type: 'step', op: { type: 'add', items } })

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
    expect(isEmpty(mergeOnto(base, edit(form, { title: '   ', description: '  ' }), base, false))).toBe(true)
    expect(isEmpty(mergeOnto(base, edit(form, { title: 'Call mum' }), base, false))).toBe(false)
    expect(isEmpty(mergeOnto(base, edit(form, { tags: '#home' }), base, false))).toBe(false)
    expect(isEmpty(mergeOnto(base, addSteps(form, [{ id: 'c1', text: 'Ring', done: false }]), base, false))).toBe(false)
  })

  it('finds nothing to save in a form nobody touched', () => {
    const base = task({ dueAt: '2026-09-14T08:00:00.000Z', tags: ['home'], estimateCost: 40, bill: { kind: 'bill', payee: 'British Gas' }, recurrence: { freq: 'monthly' } })
    expect(isDirty(initForm(base), base, true)).toBe(false)
    expect(isDirty(edit(initForm(base), { estimateCost: '41' }), base, true)).toBe(true)
  })
})

describe('a task’s old notes and link open inside its description', () => {
  const base = task({ description: 'Hinges are loose.', notes: 'Measure first\nthen buy', link: 'https://example.com/hinges' })

  it('shows each under the description after a blank line, and that alone is not an unsaved change', () => {
    const form = initForm(base)
    expect(form.description).toBe('Hinges are loose.\n\nMeasure first\nthen buy\n\nhttps://example.com/hinges')
    expect(isDirty(form, base, true)).toBe(false)
  })

  it('writes them into the description on save, and clears notes and link only then', () => {
    const next = mergeOnto(base, initForm(base), base, true)
    expect(next.description).toBe('Hinges are loose.\n\nMeasure first\nthen buy\n\nhttps://example.com/hinges')
    expect(next.notes).toBeUndefined()
    expect(next.link).toBeUndefined()
    // reflowed, the description still holds the note: line breaks and spacing are not content
    const reflowed = edit(initForm(base), { description: 'Hinges are loose.\nMeasure first then buy.\nhttps://example.com/hinges' })
    expect(mergeOnto(base, reflowed, base, true).notes).toBeUndefined()
    const spaced = edit(initForm(base), { description: 'Hinges are loose.   Measure first   then buy   https://example.com/hinges' })
    expect(mergeOnto(base, spaced, base, true).notes).toBeUndefined()
  })

  it('keeps a note taken back out of the description, and one changed elsewhere meanwhile', () => {
    const trimmed = edit(initForm(base), { description: 'Hinges are loose.\n\nhttps://example.com/hinges' })
    const next = mergeOnto(base, trimmed, base, true)
    expect(next.notes).toBe('Measure first\nthen buy')
    expect(next.link).toBeUndefined()
    // another device rewrote the notes while this editor was open
    const current: Task = { ...base, notes: 'Bought them', updatedAt: LATER }
    expect(mergeOnto(current, initForm(base), base, true).notes).toBe('Bought them')
  })

  it('never repeats what the description already says, and tells a longer URL from the link', () => {
    const said = task({ description: 'See https://example.com/hinges.', link: 'https://example.com/hinges/' })
    expect(initForm(said).description).toBe('See https://example.com/hinges.')
    expect(mergeOnto(said, initForm(said), said, true).link).toBeUndefined()
    const deeper = task({ description: 'https://example.com/hinges/brass', link: 'https://example.com/hinges' })
    expect(initForm(deeper).description).toBe('https://example.com/hinges/brass\n\nhttps://example.com/hinges')
  })

  it('lands a shared link in a new task’s description, once, and saves it there', () => {
    const shared = task({ title: '', link: 'https://example.com/recipe' })
    const form = initForm(shared)
    expect(form.description).toBe('https://example.com/recipe')
    // the capture effect adds the URL again; it is already there
    expect(appendOnce(form.description, 'https://example.com/recipe')).toBe(form.description)
    expect(appendOnce('Read later', 'https://example.com/recipe')).toBe('Read later\n\nhttps://example.com/recipe')
    const next = mergeOnto(shared, form, shared, false)
    expect(next.description).toBe('https://example.com/recipe')
    expect(next.link).toBeUndefined()
  })
})

describe('GitHub from the description', () => {
  const issue = 'https://github.com/00xJS/Drafter/issues/12'
  const pull = 'https://github.com/00xJS/Drafter/pull/3'

  it('links the first GitHub issue in the description when the task has none', () => {
    const base = task({ description: `Tracking ${issue}, see also ${pull}` })
    const form = initForm(base)
    expect(isDirty(form, base, true)).toBe(false)
    expect(cardUrl(form)).toBe(issue)
    expect(mergeOnto(base, form, base, true).githubUrl).toBe(issue)
    expect(descriptionLinks(form.description, cardUrl(form))).toEqual([pull])
  })

  it('keeps the task’s own GitHub link over one in the text, and unlinks when asked', () => {
    const base = task({ githubUrl: pull, description: `Tracking ${issue}` })
    const form = initForm(base)
    expect(cardUrl(form)).toBe(pull)
    expect(mergeOnto(base, form, base, true).githubUrl).toBe(pull)
    expect(descriptionLinks(form.description, cardUrl(form))).toEqual([issue])
    // unlinked, the issue in the text takes over on save
    expect(mergeOnto(base, edit(form, { githubUrl: '' }), base, true).githubUrl).toBe(issue)
    const bare = task({ githubUrl: pull })
    expect(mergeOnto(bare, edit(initForm(bare), { githubUrl: '' }), bare, true).githubUrl).toBeUndefined()
  })

  // B15: Unlink used not to stick while the address was still in the text, as
  // the rule above linked it again on save. Unlink now takes it out of the
  // description too, and its Undo puts both back.
  it('Unlink takes the address out of the description too, so the save leaves the task unlinked', () => {
    const base = task({ githubUrl: issue, description: `Tracking ${issue}\nParts: https://example.com/hinges` })
    const form = initForm(base)
    const { patch } = unlinkGithub(form)
    expect(patch).toEqual({ githubUrl: '', description: 'Tracking\nParts: https://example.com/hinges' })
    const unlinked = edit(form, patch)
    expect(cardUrl(unlinked)).toBeUndefined()
    expect(descriptionLinks(unlinked.description, cardUrl(unlinked))).toEqual(['https://example.com/hinges'])
    const saved = mergeOnto(base, unlinked, base, true)
    expect(saved.githubUrl).toBeUndefined()
    expect(saved.description).toBe('Tracking\nParts: https://example.com/hinges')
  })

  it('Unlink’s Undo puts the link and the text back, and then there is nothing to save', () => {
    const base = task({ githubUrl: issue, description: `Tracking ${issue}` })
    const form = initForm(base)
    const { patch, unlinked } = unlinkGithub(form)
    const undone = edit(edit(form, patch), f => relinkGithub(f, unlinked))
    expect(undone).toMatchObject({ githubUrl: issue, description: `Tracking ${issue}` })
    expect(isDirty(undone, base, true)).toBe(false)
    expect(mergeOnto(base, undone, base, true)).toMatchObject({ githubUrl: issue, description: `Tracking ${issue}` })
  })

  it('Undo after typing keeps what was typed and adds the address back below it', () => {
    const base = task({ githubUrl: issue, description: `Tracking ${issue}` })
    const form = initForm(base)
    const { patch, unlinked } = unlinkGithub(form)
    const typed = edit(edit(form, patch), { description: 'Tracking the hinge order' })
    expect(edit(typed, f => relinkGithub(f, unlinked))).toMatchObject({ githubUrl: issue, description: `Tracking the hinge order\n\n${issue}` })
  })

  it('Unlink leaves a description that never held the address as it is, and so does its Undo', () => {
    const base = task({ githubUrl: issue, description: 'Fix the hinge' })
    const { patch, unlinked } = unlinkGithub(initForm(base))
    expect(patch).toEqual({ githubUrl: '', description: 'Fix the hinge' })
    expect(relinkGithub({ description: 'Fix the hinge, and oil it' }, unlinked)).toEqual({ githubUrl: issue, description: 'Fix the hinge, and oil it' })
  })

  it('Unlink takes the same issue out however the text writes it, so the save cannot link it again, and Undo gives the text back', () => {
    // a comment's permalink pasted from GitHub, http with www and another case,
    // and a markdown link carrying a ?query: each one the card would show, and
    // the save would link, as issue 12
    const comment = `${issue}#issuecomment-99`
    const plain = 'http://www.github.com/00xjs/drafter/issues/12'
    const base = task({ githubUrl: issue, description: `See ${comment} for the fix.\n${plain}\n[the thread](${issue}?notification_referrer_id=7)\nParts: https://example.com/hinges` })
    const form = initForm(base)
    const { patch, unlinked } = unlinkGithub(form)
    expect(patch).toEqual({ githubUrl: '', description: 'See for the fix.\nthe thread\nParts: https://example.com/hinges' })
    const after = edit(form, patch)
    expect(cardUrl(after)).toBeUndefined()
    const saved = mergeOnto(base, after, base, true)
    expect(saved.githubUrl).toBeUndefined()
    expect(saved.description).toBe('See for the fix.\nthe thread\nParts: https://example.com/hinges')
    const undone = edit(after, f => relinkGithub(f, unlinked))
    expect(undone).toMatchObject({ githubUrl: issue, description: base.description })
    expect(isDirty(undone, base, true)).toBe(false)
  })

  it('Unlink takes only its own address: another GitHub address in the text stays, and is the card’s now', () => {
    const base = task({ githubUrl: issue, description: `Tracking ${issue}, see also ${pull}` })
    const form = edit(initForm(base), unlinkGithub(initForm(base)).patch)
    expect(form.description).toBe(`Tracking, see also ${pull}`)
    expect(cardUrl(form)).toBe(pull)
  })

  it('counts only what the card can show', () => {
    for (const url of [issue, pull, 'https://github.com/orgs/acme/projects/4', 'https://github.com/users/joe/projects/1', 'https://github.com/00xJS/Drafter']) {
      expect(isGithubCardUrl(url), url).toBe(true)
    }
    for (const url of ['https://github.com/00xJS/Drafter/blob/main/README.md', 'https://github.com/orgs/acme', 'https://github.com/settings', 'https://example.com/00xJS/Drafter/issues/1']) {
      expect(isGithubCardUrl(url), url).toBe(false)
    }
  })
})

describe('withoutUrl: an address taken out of a description', () => {
  const issue = 'https://github.com/00xJS/Drafter/issues/12'

  it('closes up the space it leaves in a sentence, before it or else after it', () => {
    expect(withoutUrl(`See ${issue} for the plan.`, issue)).toBe('See for the plan.')
    expect(withoutUrl(`${issue} is the plan`, issue)).toBe('is the plan')
    // the full stop ends the sentence, not the address
    expect(withoutUrl(`Tracking ${issue}.`, issue)).toBe('Tracking.')
  })

  it('takes a line it was alone on, and keeps one blank line between what was either side', () => {
    expect(withoutUrl(`Fix it\n\n${issue}\n\nMore`, issue)).toBe('Fix it\n\nMore')
    expect(withoutUrl(`Fix it\n${issue}\nMore`, issue)).toBe('Fix it\nMore')
    expect(withoutUrl(`${issue}\n\nNotes`, issue)).toBe('Notes')
    expect(withoutUrl(`Notes\n\n${issue}`, issue)).toBe('Notes')
    expect(withoutUrl(issue, issue)).toBe('')
  })

  it('finds it however it is written: more than once, with a trailing slash, as a link’s target', () => {
    expect(withoutUrl(`${issue}/ and again ${issue}`, issue)).toBe('and again')
    expect(withoutUrl(`The [issue](${issue}) is open`, issue)).toBe('The issue is open')
  })

  it('finds a GitHub item however it is written: a comment’s anchor, http, www, any case, or the pull request of that number', () => {
    expect(withoutUrl(`Fixed, see ${issue}#issuecomment-99`, issue)).toBe('Fixed, see')
    expect(withoutUrl('See http://www.github.com/00xjs/DRAFTER/issues/12?q=1 now', issue)).toBe('See now')
    // an issue and a pull request share their repository's numbers
    expect(withoutUrl('Merged in https://github.com/00xJS/Drafter/pull/12', issue)).toBe('Merged in')
    expect(withoutUrl('Board: https://github.com/orgs/acme/projects/4/views/2', 'https://github.com/orgs/Acme/projects/4')).toBe('Board:')
    expect(withoutUrl('Home: https://github.com/00xjs/drafter#readme', 'https://github.com/00xJS/Drafter')).toBe('Home:')
  })

  it('leaves every other address, word and blank line as it was', () => {
    const text = 'Parts: https://example.com/hinges\n\n\nSee https://github.com/00xJS/Drafter/issues/120 and [the pull](https://github.com/00xJS/Drafter/pull/3)  too'
    expect(withoutUrl(text, issue)).toBe(text)
    // the same number in another repository, and a page of the repository that is not its home
    const others = 'https://github.com/00xJS/Other/issues/12 and https://github.com/00xJS/Drafter/blob/main/README.md'
    expect(withoutUrl(others, issue)).toBe(others)
    expect(withoutUrl(others, 'https://github.com/00xJS/Drafter')).toBe(others)
  })
})

describe('link chips under the description', () => {
  it('finds each URL once, without the punctuation after it, keeping a bracket the URL opened', () => {
    const text = 'Read https://example.com/a. Then (see https://en.wikipedia.org/wiki/Gate_(disambiguation)) and https://example.com/a again, plus [docs](https://docs.example.com/x).'
    expect(urlsIn(text)).toEqual(['https://example.com/a', 'https://en.wikipedia.org/wiki/Gate_(disambiguation)', 'https://docs.example.com/x'])
    expect(urlsIn('no links here, only www.example.com')).toEqual([])
  })

  it('labels a chip with the host and path, shortened', () => {
    expect(linkLabel('https://www.example.com/a/b/?q=1')).toBe('example.com/a/b')
    expect(linkLabel('https://example.com')).toBe('example.com')
    const long = linkLabel(`https://example.com/${'x'.repeat(80)}`)
    expect(long).toHaveLength(40)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('the project', () => {
  it('is carried through a save untouched — even one moved to another project meanwhile', () => {
    const base = task({ projectId: 'pr1' })
    const form = edit(initForm(base), { title: 'Fix the side gate' })
    expect(mergeOnto(base, form, base, true).projectId).toBe('pr1')
    const moved: Task = { ...base, projectId: 'pr2', updatedAt: LATER }
    expect(mergeOnto(moved, form, base, true).projectId).toBe('pr2')
  })

  it('is nothing on a new task unless its preset brings one', () => {
    const blank = task({ title: 'Call the council' })
    expect(mergeOnto(blank, initForm(blank), blank, false).projectId).toBeUndefined()
    const fromTemplate = task({ title: 'Paint the fence', projectId: 'pr1' })
    expect(mergeOnto(fromTemplate, initForm(fromTemplate), fromTemplate, false).projectId).toBe('pr1')
  })
})

describe('estimate and actual cost', () => {
  it('shows for a bill, and for any other task only while it has a value', () => {
    const plain = task()
    expect(costsVisible(initForm(plain), plain)).toBe(false)
    expect(costsVisible(edit(initForm(plain), { bill: { kind: 'bill' } }), plain)).toBe(true)
    const estimated = task({ estimateCost: 40 })
    expect(costsVisible(initForm(estimated), estimated)).toBe(true)
    // cleared while open: still shown, so the field does not vanish under the cursor
    expect(costsVisible(edit(initForm(estimated), { estimateCost: '' }), estimated)).toBe(true)
    expect(costsVisible(initForm(task({ actualCost: 0 })), task({ actualCost: 0 }))).toBe(true)
    // typed on a bill, then unticked: the amount stays in view
    expect(costsVisible(edit(initForm(plain), { actualCost: '12' }), plain)).toBe(true)
  })
})

describe('people typed into the picker', () => {
  const person = (id: string, name: string): Person => ({ kind: 'person', id, name, color: '#f97316', group: 'family', createdAt: OPENED, updatedAt: OPENED })
  const people = [person('p1', 'Sam'), person('p2', 'Samantha'), person('p3', 'Dave')]

  it('picks an existing name in any case or spacing, so it is never added twice', () => {
    const found = peopleSearch('  sAm ', people, [])
    expect(found.exact?.id).toBe('p1')
    expect(found.matches.map(p => p.id)).toEqual(['p1', 'p2'])
    // already on the task: still found as exact, so no "Add" for them either
    const attached = peopleSearch('Sam', people, ['p1'])
    expect(attached.exact?.id).toBe('p1')
    expect(attached.matches.map(p => p.id)).toEqual(['p2'])
  })

  it('offers someone new by the name as typed', () => {
    const found = peopleSearch('  Priya   Shah ', people, [])
    expect(found).toEqual({ name: 'Priya Shah', exact: undefined, matches: [] })
    expect(peopleSearch('   ', people, []).name).toBe('')
  })

  it('makes a person shaped as the People tab saves one', () => {
    const p = newPerson('  Priya Shah ', { id: 'p9', color: '#22c55e', now: new Date(LATER) })
    expect(p).toEqual({ kind: 'person', id: 'p9', name: 'Priya Shah', group: 'family', color: '#22c55e', createdAt: LATER, updatedAt: LATER })
    expect(p.cadenceDays).toBeUndefined()
    expect(sanitizePerson(p)).toEqual({ ...p, emoji: undefined, cadenceDays: undefined, notes: undefined, birthday: undefined, anniversary: undefined, ownerId: undefined, deletedAt: undefined, purged: undefined })
  })
})

describe('on a saved task every checklist edit and comment is written as it happens, never by the save', () => {
  const a = { id: 'a', text: 'Buy hinges', done: false }
  const b = { id: 'b', text: 'Oil them', done: false }

  it('never overwrites them with the form copy', () => {
    const base = task({ checklist: [a], comments: [{ id: 'm1', body: 'Called Dave', createdAt: OPENED }] })
    let form = addSteps(initForm(base), [b])
    form = edit(form, f => ({ title: 'Fix the side gate', comments: f.comments.filter(c => c.id !== 'm1') }))
    // meanwhile a tick landed from the phone, and a bot added a comment
    const current: Task = {
      ...base,
      checklist: [{ ...a, done: true }],
      comments: [...base.comments!, { id: 'm2', body: 'Parts ordered', createdAt: LATER }],
      updatedAt: LATER,
    }
    const next = mergeOnto(current, form, base, true)
    expect(next.title).toBe('Fix the side gate')
    expect(next.checklist).toEqual(current.checklist)
    expect(next.comments).toEqual(current.comments)
  })

  it('writes an added, renamed, ticked or removed step at once, onto the freshest copy', () => {
    // opened with a and b; since then the phone ticked a and added c
    const current = task({ checklist: [{ ...a, done: true }, b, { id: 'c', text: 'Paint', done: false }], updatedAt: LATER })
    const added = commitStep(current, { type: 'add', items: [{ id: 'd', text: '  Tidy up ', done: false }] })!
    expect(added.checklist!.map(c => c.text)).toEqual(['Buy hinges', 'Oil them', 'Paint', 'Tidy up'])
    expect(added.checklist![0].done).toBe(true)
    expect(Date.parse(added.updatedAt)).toBeGreaterThan(Date.parse(LATER))

    const renamed = commitStep(added, { type: 'rename', id: 'b', text: ' Oil them well ' })!
    expect(renamed.checklist!.find(c => c.id === 'b')).toEqual({ id: 'b', text: 'Oil them well', done: false })
    const ticked = commitStep(renamed, { type: 'tick', id: 'c', done: true })!
    expect(ticked.checklist!.find(c => c.id === 'c')!.done).toBe(true)
    const removed = commitStep(ticked, { type: 'remove', id: 'a' }, { type: 'remove', id: 'b' }, { type: 'remove', id: 'c' }, { type: 'remove', id: 'd' })!
    expect(removed.checklist).toBeUndefined()
  })

  it('writes nothing for an edit that changes nothing', () => {
    const current = task({ checklist: [a] })
    expect(commitStep(current, { type: 'rename', id: 'a', text: 'Buy hinges ' })).toBeNull()
    expect(commitStep(current, { type: 'rename', id: 'a', text: '   ' })).toBeNull()
    expect(commitStep(current, { type: 'tick', id: 'gone', done: true })).toBeNull()
    expect(commitStep(current, { type: 'add', items: [{ ...a }] })).toBeNull()
    expect(commitStep(current, { type: 'add', items: [{ id: 'e', text: '  ', done: false }] })).toBeNull()
  })

  it('counts no step edit there as unsaved, while a new task keeps its steps for the save', () => {
    const base = task({ checklist: [a, b] })
    let form = formReducer(initForm(base), { type: 'step', op: { type: 'tick', id: 'a', done: true } })
    form = formReducer(form, { type: 'step', op: { type: 'rename', id: 'b', text: 'Oil them well' } })
    form = formReducer(form, { type: 'step', op: { type: 'remove', id: 'a' } })
    form = addSteps(form, [{ id: 'c', text: 'Paint', done: false }])
    expect(form.checklist.map(c => c.text)).toEqual(['Oil them well', 'Paint'])
    expect(isDirty(form, base, true)).toBe(false)
    expect(isDirty(form, base, false)).toBe(true)
  })

  it('flushes a rename still being typed, and only a step that was typed into', () => {
    const form: ChecklistItem[] = [
      { ...a, text: 'Buy brass hinges' }, // typed into
      { ...b, text: 'Oil them' }, // only passed through
      { id: 'c', text: '   ', done: false }, // typed to nothing
    ]
    expect(pendingRenames(form, new Set(['a', 'c']))).toEqual([{ type: 'rename', id: 'a', text: 'Buy brass hinges' }])
    const current = task({ checklist: [a, { ...b, text: 'Oil them twice' }, { id: 'c', text: 'Paint', done: false }] })
    const next = commitStep(current, ...pendingRenames(form, new Set(['a', 'c'])))!
    expect(next.checklist!.map(c => c.text)).toEqual(['Buy brass hinges', 'Oil them twice', 'Paint'])
  })

  it("saves a new task's steps trimmed, without blank ones", () => {
    const base = task({ title: '' })
    let form = addSteps(initForm(base), [
      { id: 'a', text: 'Ring the council', done: false },
      { id: 'b', text: '   ', done: false },
    ])
    form = edit(form, f => ({ checklist: [...f.checklist, { id: 'c', text: '  Chase them ', done: false }, { id: 'd', text: ' ', done: false }] }))
    expect(formValues(form, base, false).checklist).toEqual([
      { id: 'a', text: 'Ring the council', done: false },
      { id: 'c', text: 'Chase them', done: false },
    ])
  })
})

describe('applying a captured sentence', () => {
  it('matches people by name, merges tags, and sets the date and repeat — never a project', () => {
    const base = task({ title: 'dentist tomorrow 3pm' })
    const form = edit(initForm(base), { tags: 'health', peopleIds: ['p1'] })
    const next = formReducer(form, {
      type: 'applyCapture',
      capture: { title: 'Dentist', dueAt: '2026-09-13T14:00:00.000Z', priority: 'high', peopleNames: ['Mum', 'Nobody'], tags: ['health', 'teeth'], recurrence: 'monthly' },
      people: [
        { id: 'p1', name: 'Dad' },
        { id: 'p2', name: 'mum' },
      ],
    })
    expect(next).toMatchObject({ title: 'Dentist', priority: 'high', projectId: '', peopleIds: ['p1', 'p2'], tags: 'health, teeth', freq: 'monthly' })
    expect(next.dueAt).toBe(toLocalInput('2026-09-13T14:00:00.000Z'))
  })

  it('leaves alone whatever the sentence did not mention, the project included', () => {
    const base = task({ title: 'Gate', projectId: 'pr9', priority: 'low' })
    const form = initForm(base)
    // a model that still answers with a project name (an older prompt) is not listened to
    const next = formReducer(form, { type: 'applyCapture', capture: { title: '', projectName: 'Unknown' } as CapturedFields, people: [] })
    expect(next).toEqual(form)
    expect(next.projectId).toBe('pr9')
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
