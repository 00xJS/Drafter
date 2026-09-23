import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../api'
import { parseCapture } from '../ai'
import { CapturedFields, buildCapturedTask, quickCaptureFields } from '../capture'
import { inInbox } from '../taskutils'

// The palette's Shift+Enter files a task from these two pure steps with no
// editor in between, so what they produce is exactly what lands in the store.
const now = new Date(2026, 8, 9, 10, 0, 0)
const lookup = {
  people: [
    { id: 'u-sam', name: 'Sam' },
    { id: 'u-ana', name: 'Ana Ruiz' },
  ],
}

describe('quickCaptureFields: the instant, offline read of a line', () => {
  it('reads a day and clock time and strips them from the title', () => {
    const f = quickCaptureFields('Call Sam tomorrow at 3pm', now)
    expect(f.title).toBe('Call Sam')
    const due = new Date(f.dueAt!)
    expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours(), due.getMinutes()]).toEqual([2026, 8, 10, 15, 0])
  })

  it('returns only a trimmed title when there is no date to find', () => {
    expect(quickCaptureFields('  Fix the gate latch  ', now)).toEqual({ title: 'Fix the gate latch' })
  })

  it('keeps a title to 140 characters', () => {
    expect(quickCaptureFields('x'.repeat(200), now).title).toHaveLength(140)
  })
})

describe('buildCapturedTask: fields become a task the way the editor would apply them', () => {
  it('a bare title is an Inbox task: todo, normal, undated, unprojected', () => {
    const t = buildCapturedTask({ title: 'Fix the gate latch' }, lookup, { id: 't1', now })
    expect(t).toEqual({
      kind: 'task',
      id: 't1',
      title: 'Fix the gate latch',
      description: '',
      status: 'todo',
      priority: 'normal',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      tags: [],
    })
    // Today's Inbox rule, the same function Today uses
    expect(inInbox(t)).toBe(true)
    expect('projectId' in t).toBe(false)
    expect('peopleIds' in t).toBe(false)
    expect('dueAt' in t).toBe(false)
  })

  it('never files the task under a project, even when the fields still name one', () => {
    // an answer shaped by the old prompt, which asked for a project name
    const t = buildCapturedTask({ title: 'Descale the kettle', projectName: 'LIFE' } as CapturedFields, lookup, { id: 't2', now })
    expect('projectId' in t).toBe(false)
    expect(inInbox(t)).toBe(true)
  })

  it('drops a person it does not know rather than guessing', () => {
    const t = buildCapturedTask({ title: 'Ring the plumber', peopleNames: ['Nobody'] }, lookup, { id: 't3', now })
    expect(t.peopleIds).toBeUndefined()
  })

  it('maps people to ids and de-dupes them', () => {
    const t = buildCapturedTask({ title: 'Lunch', peopleNames: ['sam', 'Sam', 'ana ruiz'] }, lookup, { id: 't4', now })
    expect(t.peopleIds).toEqual(['u-sam', 'u-ana'])
  })

  it('carries the date, priority, lowercase tags and recurrence through', () => {
    const f = quickCaptureFields('Water the plants tomorrow at 8am', now)
    const t = buildCapturedTask({ ...f, priority: 'high', tags: [' Home ', 'home', ''], recurrence: 'weekly' }, lookup, { id: 't5', now })
    expect(t.title).toBe('Water the plants')
    expect(t.dueAt).toBe(f.dueAt)
    expect(t.priority).toBe('high')
    expect(t.tags).toEqual(['home'])
    expect(t.recurrence).toEqual({ freq: 'weekly' })
  })

  it('trims and truncates the title to 140', () => {
    const t = buildCapturedTask({ title: '  ' + 'y'.repeat(200) }, lookup, { id: 't6', now })
    expect(t.title).toHaveLength(140)
  })
})

describe('parseCapture: the model is never asked for a project', () => {
  const reply = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) }) as unknown as Response
  beforeEach(() => vi.mocked(apiFetch).mockReset())

  it('sends no project list and asks for no project name', async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply('{"title":"Paint the fence"}'))
    await parseCapture('paint the fence', { now, personNames: ['Sam'] })
    const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]!.body)) as { system: string; prompt: string }
    expect(body.system).not.toMatch(/project/i)
    expect(body.prompt).not.toMatch(/project/i)
    // people are still offered by name
    expect(body.prompt).toContain('People: ["Sam"]')
  })

  it('drops a project name the model offers anyway', async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply('{"title":"Paint the fence","projectName":"LIFE","peopleNames":["sam"]}'))
    const parsed = await parseCapture('paint the fence with Sam', { now, personNames: ['Sam'] })
    expect(parsed).not.toHaveProperty('projectName')
    expect(parsed.peopleNames).toEqual(['Sam'])
    expect('projectId' in buildCapturedTask(parsed, lookup, { id: 't7', now })).toBe(false)
  })
})
