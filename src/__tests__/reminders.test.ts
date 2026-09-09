import { describe, expect, it } from 'vitest'
import { Person, Task } from '../types'
import { buildLocalReminders } from '../reminders'

const NOW = new Date(2026, 8, 7, 12, 0) // Mon 7 Sep 2026, noon local

const task = (id: string, extra: Partial<Task>): Task => ({
  kind: 'task',
  id,
  title: `Task ${id}`,
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  tags: [],
  ...extra,
})

const person = (id: string, birthday: string): Person => ({
  kind: 'person',
  id,
  name: `Person ${id}`,
  group: 'family',
  color: '#f97316',
  birthday,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
})

describe('local reminders', () => {
  it('fires at a timed task\'s due time and opens that task', () => {
    const due = new Date(2026, 8, 8, 18, 30)
    const [r] = buildLocalReminders([task('a', { title: 'Bins out', dueAt: due.toISOString() })], [], NOW)
    expect(r.at.getTime()).toBe(due.getTime())
    expect(r.title).toBe('Due now: Bins out')
    expect(r.url).toBe('/?task=a')
    expect(r.actionTypeId).toBe('DRAFTER_TASK')
  })

  it('moves a date-only (midnight) due to the morning instead of 00:00', () => {
    const [r] = buildLocalReminders([task('a', { dueAt: new Date(2026, 8, 9, 0, 0).toISOString() })], [], NOW)
    expect([r.at.getHours(), r.at.getMinutes()]).toEqual([9, 0])
  })

  it('skips done, undated, past and far-future work', () => {
    const list = buildLocalReminders(
      [
        task('done', { status: 'done', dueAt: new Date(2026, 8, 8).toISOString() }),
        task('undated', {}),
        task('past', { dueAt: new Date(2026, 8, 6, 10).toISOString() }),
        task('far', { dueAt: new Date(2026, 11, 25).toISOString() }),
        task('soon', { dueAt: new Date(2026, 8, 10, 8).toISOString() }),
      ],
      [],
      NOW,
    )
    expect(list.map(r => r.url)).toEqual(['/?task=soon'])
  })

  it('adds a 9am reminder on the day of a birthday', () => {
    const list = buildLocalReminders([], [person('mum', '1960-09-12')], NOW)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("Person mum's birthday today")
    expect([list[0].at.getMonth(), list[0].at.getDate(), list[0].at.getHours()]).toEqual([8, 12, 9])
    expect(list[0].body).toContain('66 years')
    expect(list[0].actionTypeId).toBe('DRAFTER_OCCASION')
  })

  it('skips task due rows when skipTaskDue is set (APNs already subscribed)', () => {
    const due = new Date(2026, 8, 8, 18, 30)
    const list = buildLocalReminders([task('a', { title: 'Bins out', dueAt: due.toISOString() })], [person('mum', '1960-09-12')], NOW, 30, {
      skipTaskDue: true,
    })
    expect(list.every(r => !r.url.startsWith('/?task='))).toBe(true)
    expect(list.some(r => r.title.includes('birthday'))).toBe(true)
  })
})

describe('generic lock-screen reminders', () => {
  it('keeps titles and names out of the notification but the deep link intact', () => {
    const due = new Date(2026, 8, 8, 18, 30)
    const list = buildLocalReminders([task('a', { title: 'Call the bank', dueAt: due.toISOString(), description: 'account 1234' })], [person('mum', '1960-09-12')], NOW, 30, { generic: true })
    const taskRow = list.find(r => r.url === '/?task=a')!
    const occasion = list.find(r => r.url === '/?saw=mum')!
    // a banner that will not say which task it is must not offer a blind Done
    expect(taskRow.actionTypeId).toBeUndefined()
    expect(occasion.actionTypeId).toBeUndefined()
    expect(taskRow.title).toBe('Something is due')
    expect(taskRow.body).not.toContain('1234')
    expect(occasion.title).toBe('An occasion today')
    expect(occasion.body).not.toContain('mum')
    expect(JSON.stringify(list)).not.toContain('Call the bank')
  })
})
