import { describe, expect, it } from 'vitest'
import {
  boardDateToDue,
  defaultColumnMap,
  dueDateOf,
  optionForStatus,
  projectSyncEnabled,
  pushPlan,
  reconcileProjectItems,
  sameGithubUrl,
  statusForOption,
} from '../githubsync'
import { sanitizeProject } from '../schema'
import { GithubProjectItem } from '../github'
import { GithubProjectSync, Project, Task } from '../types'

const ISSUE = 'https://github.com/you/repo/issues/7'

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 't1',
    title: 'Fix the sink',
    description: '',
    status: 'todo',
    priority: 'normal',
    projectId: 'p1',
    githubUrl: ISSUE,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    tags: [],
    ...over,
  }
}

function project(over: Partial<Project> = {}): Project {
  return {
    kind: 'project',
    id: 'p1',
    name: 'House',
    color: '#f97316',
    status: 'active',
    githubUrl: 'https://github.com/users/you/projects/3',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  }
}

function item(over: Partial<GithubProjectItem> = {}): GithubProjectItem {
  return { itemId: 'i1', updatedAt: '2026-09-02T10:00:00.000Z', contentUrl: ISSUE, ...over }
}

const SYNC: GithubProjectSync = {
  statusFieldId: 'f-status',
  dateFieldId: 'f-due',
  columns: { wishlist: 'o-wish', todo: 'o-todo', doing: 'o-doing', done: 'o-done' },
}

/** A local day key for a Date, matching what the board's date field stores. */
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('defaultColumnMap', () => {
  it('matches the Drafter labels case- and punctuation-insensitively', () => {
    const map = defaultColumnMap([
      { id: 'a', name: 'WISHLIST' },
      { id: 'b', name: 'to-do' },
      { id: 'c', name: 'Doing' },
      { id: 'd', name: 'done' },
    ])
    expect(map).toEqual({ wishlist: 'a', todo: 'b', doing: 'c', done: 'd' })
  })

  it("takes GitHub's own default columns through the aliases", () => {
    const map = defaultColumnMap([
      { id: 'x', name: 'Todo' },
      { id: 'y', name: 'In Progress' },
      { id: 'z', name: 'Done' },
    ])
    expect(map.todo).toBe('x')
    expect(map.doing).toBe('y')
    expect(map.done).toBe('z')
    expect(map.wishlist).toBeUndefined()
  })

  it('prefers the exact label over an alias and never reuses an option', () => {
    const map = defaultColumnMap([
      { id: 'p', name: 'In progress' },
      { id: 'q', name: 'Doing' },
    ])
    expect(map.doing).toBe('q')
    expect(Object.values(map).filter(v => v === 'q')).toHaveLength(1)
  })

  it('leaves a status unmapped when nothing on the board resembles it', () => {
    expect(defaultColumnMap([{ id: 'k', name: 'Icebox 🧊' }])).toEqual({})
  })
})

describe('status ↔ column mapping', () => {
  it('maps both ways', () => {
    expect(optionForStatus(SYNC, 'doing')).toBe('o-doing')
    expect(statusForOption(SYNC, 'o-doing')).toBe('doing')
  })

  it('is undefined for an unmapped status or an unknown option', () => {
    expect(optionForStatus({ ...SYNC, columns: { done: 'o-done' } }, 'doing')).toBeUndefined()
    expect(statusForOption(SYNC, 'o-nope')).toBeUndefined()
    expect(statusForOption(SYNC, undefined)).toBeUndefined()
    expect(optionForStatus(undefined, 'done')).toBeUndefined()
  })
})

describe('projectSyncEnabled', () => {
  it('needs a board URL, a status field and at least one column', () => {
    expect(projectSyncEnabled(project())).toBe(false)
    expect(projectSyncEnabled(project({ githubProjectSync: SYNC }))).toBe(true)
    expect(projectSyncEnabled(project({ githubProjectSync: { statusFieldId: 'f-status' } }))).toBe(false)
    expect(projectSyncEnabled(project({ githubProjectSync: { dateFieldId: 'f-due' } }))).toBe(true)
    expect(projectSyncEnabled(project({ githubUrl: 'https://github.com/you/repo', githubProjectSync: SYNC }))).toBe(false)
    expect(projectSyncEnabled(undefined)).toBe(false)
  })
})

describe('pushPlan', () => {
  /** A task edited here after the board row was last touched — the ordinary push. */
  const edited = (over: Partial<Task> = {}) => task({ updatedAt: '2026-09-03T10:00:00.000Z', ...over })

  it('writes the mapped column and the due date', () => {
    const t = edited({ status: 'doing', dueAt: new Date(2026, 8, 20, 9, 0).toISOString() })
    expect(pushPlan(t, SYNC, item({ statusOptionId: 'o-todo' }))).toEqual({ optionId: 'o-doing', date: '2026-09-20' })
  })

  it('is a no-op when the board already agrees', () => {
    const day = new Date(2026, 8, 20, 9, 0)
    const t = edited({ status: 'doing', dueAt: day.toISOString() })
    expect(pushPlan(t, SYNC, item({ statusOptionId: 'o-doing', date: dayOf(day) }))).toBeNull()
  })

  it('never clears a board date the task simply does not have', () => {
    // the mirror of the pull's rule: silence is not an instruction to wipe a
    // date somebody set on the board, and a clear cannot be taken back
    const t = edited({ status: 'todo' })
    expect(pushPlan(t, SYNC, item({ statusOptionId: 'o-todo', date: '2026-09-20' }))).toBeNull()
    // and it does not suppress the status the same push was there to write
    expect(pushPlan(edited({ status: 'doing' }), SYNC, item({ statusOptionId: 'o-todo', date: '2026-09-20' }))).toEqual({ optionId: 'o-doing' })
  })

  it('leaves a row GitHub touched after the local edit alone, and lets the pull have it', () => {
    const stale = task({ status: 'doing', updatedAt: '2026-09-01T10:00:00.000Z' })
    expect(pushPlan(stale, SYNC, item({ statusOptionId: 'o-todo', updatedAt: '2026-09-02T10:00:00.000Z' }))).toBeNull()
    // an equal stamp is not "newer", so the push still goes
    expect(pushPlan(stale, SYNC, item({ statusOptionId: 'o-todo', updatedAt: '2026-09-01T10:00:00.000Z' }))).toEqual({ optionId: 'o-doing' })
    // and an unreadable board stamp does not veto the user's own edit
    expect(pushPlan(stale, SYNC, item({ statusOptionId: 'o-todo', updatedAt: 'not a date' }))).toEqual({ optionId: 'o-doing' })
  })

  it('lets a second status change through, now that the push carries the stamp the edit wrote', () => {
    // the board row sits a couple of seconds after the PREVIOUS edit, because
    // Drafter's own earlier push put it there. Push the task as the edit stored
    // it and the guard is satisfied; push the pre-edit copy (the bug) and every
    // status change after the first is silently dropped.
    const before = '2026-09-03T10:00:00.000Z'
    const row = item({ statusOptionId: 'o-doing', updatedAt: '2026-09-03T10:00:02.500Z' })
    expect(pushPlan(task({ status: 'done', updatedAt: '2026-09-03T10:05:00.000Z' }), SYNC, row)).toEqual({ optionId: 'o-done' })
    expect(pushPlan(task({ status: 'done', updatedAt: before }), SYNC, row)).toBeNull()
  })

  it('leaves dates alone when no date field is mapped', () => {
    const t = edited({ status: 'done', dueAt: new Date(2026, 8, 20, 9, 0).toISOString() })
    expect(pushPlan(t, { ...SYNC, dateFieldId: undefined }, item({ statusOptionId: 'o-todo', date: '2000-01-01' }))).toEqual({ optionId: 'o-done' })
  })

  it('writes nothing for a status with no column', () => {
    const t = edited({ status: 'blocked' })
    expect(pushPlan(t, { statusFieldId: 'f-status', columns: SYNC.columns }, item({ statusOptionId: 'o-todo' }))).toBeNull()
  })
})

describe('reconcileProjectItems', () => {
  it('moves a task whose board row changed after it', () => {
    const changes = reconcileProjectItems([task()], [item({ statusOptionId: 'o-doing', statusName: 'In progress' })], SYNC)
    expect(changes).toEqual([{ taskId: 't1', title: 'Fix the sink', status: 'doing', columnName: 'In progress', boardUpdatedAt: '2026-09-02T10:00:00.000Z' }])
  })

  it('never moves a task the user edited more recently, and equal stamps are a no-op', () => {
    const fresh = task({ updatedAt: '2026-09-03T10:00:00.000Z' })
    expect(reconcileProjectItems([fresh], [item({ statusOptionId: 'o-doing' })], SYNC)).toEqual([])
    const same = task({ updatedAt: '2026-09-02T10:00:00.000Z' })
    expect(reconcileProjectItems([same], [item({ statusOptionId: 'o-doing' })], SYNC)).toEqual([])
  })

  it('compares instants, not strings, so a second-precision row never wins a tie', () => {
    // GitHub's GraphQL DateTime has no milliseconds; lexically 'Z' sorts above '.'
    const t = task({ updatedAt: '2026-09-02T10:00:00.000Z' })
    expect(reconcileProjectItems([t], [item({ updatedAt: '2026-09-02T10:00:00Z', statusOptionId: 'o-doing' })], SYNC)).toEqual([])
    const later = task({ updatedAt: '2026-09-02T10:00:00.500Z' })
    expect(reconcileProjectItems([later], [item({ updatedAt: '2026-09-02T10:00:00Z', statusOptionId: 'o-doing' })], SYNC)).toEqual([])
    expect(reconcileProjectItems([t], [item({ updatedAt: 'not a date', statusOptionId: 'o-doing' })], SYNC)).toEqual([])
  })

  it('leaves a status with no column of its own where it is', () => {
    // blocked and canceled are never pushed, so the row's column is stale by
    // construction: the board still shows the card it was never told to move
    const blocked = task({ status: 'blocked' })
    expect(reconcileProjectItems([blocked], [item({ statusOptionId: 'o-doing', statusName: 'Doing' })], SYNC)).toEqual([])
    const wish = task({ status: 'wishlist' })
    expect(reconcileProjectItems([wish], [item({ statusOptionId: 'o-todo' })], { ...SYNC, columns: { todo: 'o-todo', doing: 'o-doing', done: 'o-done' } })).toEqual([])
    // the board still moves its due date, which it can represent
    expect(
      reconcileProjectItems([task({ status: 'blocked', dueAt: new Date(2026, 8, 20, 9, 0).toISOString() })], [item({ statusOptionId: 'o-doing', date: '2026-09-25' })], SYNC),
    ).toEqual([{ taskId: 't1', title: 'Fix the sink', dueDate: '2026-09-25', boardUpdatedAt: '2026-09-02T10:00:00.000Z' }])
  })

  it('moves nothing when two live tasks share one issue', () => {
    // a recurrence spawn (or a duplicate) carries githubUrl forward, and the row
    // cannot say which task it is about — completing one must not complete both
    const done = task({ id: 't1', status: 'done' })
    const spawn = task({ id: 't2', status: 'todo' })
    expect(reconcileProjectItems([done, spawn], [item({ statusOptionId: 'o-done', statusName: 'Done' })], SYNC)).toEqual([])
    // trashing the finished copy lets the survivor sync again
    expect(reconcileProjectItems([{ ...done, deletedAt: '2026-09-02T00:00:00.000Z' }, spawn], [item({ statusOptionId: 'o-done', statusName: 'Done' })], SYNC)).toEqual([
      { taskId: 't2', title: 'Fix the sink', status: 'done', columnName: 'Done', boardUpdatedAt: '2026-09-02T10:00:00.000Z' },
    ])
  })

  it('ignores a row that already agrees, an unmapped column and a deleted task', () => {
    expect(reconcileProjectItems([task()], [item({ statusOptionId: 'o-todo' })], SYNC)).toEqual([])
    expect(reconcileProjectItems([task()], [item({ statusOptionId: 'o-unknown' })], SYNC)).toEqual([])
    expect(reconcileProjectItems([task({ deletedAt: '2026-09-02T00:00:00.000Z' })], [item({ statusOptionId: 'o-done' })], SYNC)).toEqual([])
  })

  it('takes a changed board date but never reads a missing one as a clear', () => {
    const dated = task({ dueAt: new Date(2026, 8, 20, 9, 0).toISOString() })
    expect(reconcileProjectItems([dated], [item({ statusOptionId: 'o-todo', date: '2026-09-25' })], SYNC)).toEqual([
      { taskId: 't1', title: 'Fix the sink', dueDate: '2026-09-25', boardUpdatedAt: '2026-09-02T10:00:00.000Z' },
    ])
    expect(reconcileProjectItems([dated], [item({ statusOptionId: 'o-todo', date: dayOf(new Date(2026, 8, 20)) })], SYNC)).toEqual([])
    expect(reconcileProjectItems([dated], [item({ statusOptionId: 'o-todo' })], SYNC)).toEqual([])
  })

  it('ignores dates when no date field is mapped, and rows with no matching task', () => {
    const dated = task({ dueAt: new Date(2026, 8, 20, 9, 0).toISOString() })
    expect(reconcileProjectItems([dated], [item({ date: '2026-09-25' })], { ...SYNC, dateFieldId: undefined })).toEqual([])
    expect(reconcileProjectItems([dated], [item({ contentUrl: 'https://github.com/you/repo/issues/99', statusOptionId: 'o-done' })], SYNC)).toEqual([])
    expect(reconcileProjectItems([task({ githubUrl: undefined })], [item({ statusOptionId: 'o-done' })], SYNC)).toEqual([])
  })

  it('matches the issue URL ignoring case, a trailing slash and a query', () => {
    expect(sameGithubUrl(ISSUE, 'https://GitHub.com/You/Repo/issues/7/')).toBe(true)
    expect(sameGithubUrl(ISSUE, `${ISSUE}?utm=1#issuecomment-1`)).toBe(true)
    expect(sameGithubUrl(ISSUE, 'https://github.com/you/repo/issues/70')).toBe(false)
    expect(sameGithubUrl(undefined, ISSUE)).toBe(false)
    const changes = reconcileProjectItems([task()], [item({ contentUrl: 'https://github.com/You/Repo/issues/7/', statusOptionId: 'o-done' })], SYNC)
    expect(changes[0]?.status).toBe('done')
  })
})

describe('dates', () => {
  it('reads a task due date as a local day', () => {
    expect(dueDateOf(task({ dueAt: new Date(2026, 8, 20, 23, 30).toISOString() }))).toBe('2026-09-20')
    expect(dueDateOf(task())).toBeNull()
  })

  it('keeps the time of day a task already had, and keeps an untimed task untimed', () => {
    const timed = boardDateToDue('2026-09-25', new Date(2026, 8, 20, 9, 30).toISOString())
    expect(timed && new Date(timed).getHours()).toBe(9)
    expect(timed && new Date(timed).getMinutes()).toBe(30)
    expect(timed && dayOf(new Date(timed))).toBe('2026-09-25')
    const untimed = boardDateToDue('2026-09-25', new Date(2026, 8, 20, 0, 0).toISOString())
    expect(untimed && new Date(untimed).getHours()).toBe(0)
    expect(boardDateToDue('2026-09-25')).toBeTruthy()
    expect(boardDateToDue('not a date')).toBeUndefined()
  })
})

describe('sanitizeProject keeps the mapping', () => {
  it('round-trips the three known keys and drops everything else', () => {
    const p = sanitizeProject({
      ...project(),
      githubProjectSync: {
        statusFieldId: 'f-status',
        dateFieldId: 'f-due',
        columns: { todo: 'o-todo', done: 'o-done', nonsense: 'o-x' },
        token: 'ghp_secret',
      },
    })
    expect(p?.githubProjectSync).toEqual({ statusFieldId: 'f-status', dateFieldId: 'f-due', columns: { todo: 'o-todo', done: 'o-done' } })
  })

  it('is undefined when there is nothing usable', () => {
    expect(sanitizeProject({ ...project(), githubProjectSync: {} })?.githubProjectSync).toBeUndefined()
    expect(sanitizeProject({ ...project(), githubProjectSync: 'yes' })?.githubProjectSync).toBeUndefined()
    expect(sanitizeProject({ ...project(), githubProjectSync: { columns: [] } })?.githubProjectSync).toBeUndefined()
  })
})
