import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A captured sentence's day, in Phoenix, where the owner lives. The model was
// told the time as a UTC stamp — at 20:30 on a Wednesday there, UTC is already
// Thursday — and its answers were read in UTC too: "2026-09-24" became
// midnight in London, five in the afternoon the day before in Phoenix. Now it
// is told the time on this device's clock, and what it says without an offset
// is read on the same clock.

const zone = process.env.TZ
// set before any date below is built: the build host is in UTC
process.env.TZ = 'America/Phoenix'
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../api'
import { parseCapture, wallClock } from '../ai'
import { captureNeedsModel, modelDueAt, quickCaptureFields, simpleDateCapture } from '../capture'
import { formReducer, initForm } from '../taskform'
import type { Task } from '../types'
import { toLocalInput } from '../utils'

/** 20:30 on Wednesday 23 September 2026 in Phoenix; 03:30 on Thursday in UTC. */
const NOW = new Date('2026-09-24T03:30:00.000Z')
/** A local time in Phoenix, as the instant the app stores. */
const local = (m: number, d: number, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).toISOString()

const reply = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) }) as unknown as Response
const sent = () => JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]!.body)) as { system: string; prompt: string; reasoning?: string }

beforeEach(() => vi.mocked(apiFetch).mockReset())

describe('what the model is told', () => {
  it('the time on this device’s clock, with its zone — never a UTC stamp that is already tomorrow', async () => {
    expect(wallClock(NOW)).toBe('Wednesday 2026-09-23 20:30')
    vi.mocked(apiFetch).mockResolvedValue(reply('{"title":"Call the dentist"}'))
    await parseCapture('call the dentist next week', { now: NOW })
    expect(sent().prompt).toContain('Now: Wednesday 2026-09-23 20:30 (America/Phoenix)')
    expect(sent().prompt).not.toContain('2026-09-24T03:30')
    // and to answer in that time, with no offset
    expect(sent().prompt).toContain('in local time with no offset')
    // a capture needs no thought first
    expect(sent().reasoning).toBe('off')
  })
})

describe('the day the model names, read in Phoenix', () => {
  it('a bare day is that day with no time, not five in the afternoon the day before', () => {
    expect(modelDueAt('2026-09-24', NOW)).toBe(local(9, 24))
    expect(toLocalInput(modelDueAt('2026-09-24', NOW))).toBe('2026-09-24T00:00')
    // what Date.parse made of it
    expect(toLocalInput(new Date(Date.parse('2026-09-24')).toISOString())).toBe('2026-09-23T17:00')
  })

  it('a time with no offset is on this device’s clock; one with an offset or a Z is as it says', () => {
    expect(modelDueAt('2026-09-24T15:00', NOW)).toBe(local(9, 24, 15))
    expect(modelDueAt('2026-09-24 15:30:00', NOW)).toBe(local(9, 24, 15, 30))
    expect(modelDueAt('2026-09-24T15:00:00Z', NOW)).toBe('2026-09-24T15:00:00.000Z')
    expect(modelDueAt('2026-09-24T15:00-04:00', NOW)).toBe('2026-09-24T19:00:00.000Z')
  })

  it('drops a day the calendar does not have, anything that is not a date, and a time more than a day gone', () => {
    for (const bad of ['2026-02-30', '2026-09-24T25:00', '2026-13-01', 'soon', '', 42, null, '2025-09-24', '2026-09-22T09:00'])
      expect(modelDueAt(bad, NOW), String(bad)).toBeUndefined()
    // yesterday evening is still fine: the task is overdue, not a wrong year
    expect(modelDueAt('2026-09-23T08:00', NOW)).toBe(local(9, 23, 8))
  })

  it('end to end: a day only the model could read lands on that day in Phoenix', async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply('{"title":"Call the dentist","dueAt":"2026-09-28"}'))
    expect(await parseCapture('call the dentist next week', { now: NOW })).toMatchObject({ title: 'Call the dentist', dueAt: local(9, 28) })
  })

  it('where both find a date, the offline read of the words typed wins', async () => {
    // Thursday at 3pm, read offline; the model's UTC midnight would be Wednesday at five
    vi.mocked(apiFetch).mockResolvedValue(reply('{"title":"Call the dentist","dueAt":"2026-09-24T00:00:00Z"}'))
    expect((await parseCapture('call the dentist thursday at 3pm', { now: NOW })).dueAt).toBe(local(9, 24, 15))
  })

  it('a reply that is not an object still leaves the offline read, never a TypeError', async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply('["Call the dentist"]'))
    expect(await parseCapture('call the dentist thursday at 3pm', { now: NOW })).toMatchObject({ title: 'call the dentist', dueAt: local(9, 24, 15) })
  })
})

describe('the title as typed', () => {
  const offline = (line: string) => quickCaptureFields(line, NOW)

  it('a date alone goes into the editor under the typed title less the date, never the model’s rewording', () => {
    const parsed = { title: 'Schedule a dentist appointment', dueAt: local(9, 24, 15) }
    expect(simpleDateCapture(parsed, 'dentist thursday 3pm', NOW)).toEqual({ title: 'dentist', dueAt: local(9, 24, 15) })
    // more than a date is a proposal to read first
    expect(simpleDateCapture({ ...parsed, priority: 'high' }, 'dentist thursday 3pm', NOW)).toBeNull()
    expect(simpleDateCapture({ title: 'Dentist' }, 'dentist', NOW)).toBeNull()
  })

  it('nothing typed while the model was asked is written over', () => {
    const base: Task = {
      kind: 'task',
      id: 't1',
      title: 'dentist thursday 3pm',
      description: '',
      status: 'todo',
      priority: 'normal',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      tags: [],
    }
    const asRead = initForm(base)
    const capture = { title: 'dentist', dueAt: local(9, 24, 15) }
    // untouched meanwhile: the capture goes in
    expect(formReducer(asRead, { type: 'applyCapture', capture, people: [], asRead })).toMatchObject({ title: 'dentist', dueAt: '2026-09-24T15:00' })
    // typed over meanwhile: what was typed stays
    const typed = { ...asRead, title: 'Dentist — bring the forms', dueAt: '2026-09-25T09:00' }
    expect(formReducer(typed, { type: 'applyCapture', capture, people: [], asRead })).toMatchObject({
      title: 'Dentist — bring the forms',
      dueAt: '2026-09-25T09:00',
    })
    // Apply on a proposal is the person's own say-so, and writes both
    expect(formReducer(typed, { type: 'applyCapture', capture, people: [] })).toMatchObject({ title: 'dentist', dueAt: '2026-09-24T15:00' })
  })

  it('the palette asks the model only when the line holds something the offline read cannot', () => {
    const people = ['Sam Ortiz', 'Mum']
    expect(captureNeedsModel('water the plants tomorrow at 8am', offline('water the plants tomorrow at 8am'), people)).toBe(false)
    expect(captureNeedsModel('call mum tomorrow', offline('call mum tomorrow'), people)).toBe(true)
    expect(captureNeedsModel('lunch with Sam friday', offline('lunch with Sam friday'), people)).toBe(true)
    expect(captureNeedsModel('pay rent friday — urgent', offline('pay rent friday — urgent'), people)).toBe(true)
    expect(captureNeedsModel('bins out every monday', offline('bins out every monday'), people)).toBe(true)
    // no date found: the model may know "next weekend"
    expect(captureNeedsModel('paint the fence next weekend', offline('paint the fence next weekend'), people)).toBe(true)
    // "sam" inside another word is not Sam
    expect(captureNeedsModel('buy salmon tomorrow', offline('buy salmon tomorrow'), people)).toBe(false)
  })
})
