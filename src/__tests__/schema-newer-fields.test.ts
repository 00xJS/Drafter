import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_KINDS } from '../../shared/kinds.mts'
import { newerStamp } from '../itemops'
import { UNKNOWN_FIELDS_MAX, sanitizeItem } from '../schema'
import type { Item, Recipe } from '../types'
import { FakeServer, device, idle, ready } from './sync-fakes'

// A phone still on an older build pulled a record, dropped the fields it did
// not know, and pushed the record back without them on its next edit — and
// sync_posts replaces `data` whole, so the field was gone on every device (a
// recipe's source link, written by build 14, lost through a build-12 phone).
// A field this build has never heard of now rides along untouched: this build
// is the older one the day a newer build adds a field.

const AT = '2026-09-20T10:00:00.000Z'

/** A record of every kind this build syncs, each as little as its sanitizer takes. */
const ONE_OF_EACH: Record<string, Record<string, unknown>> = {
  // no description, so the sanitizer reaches for a pre-v3 row's `body`
  task: { kind: 'task', id: 't1', title: 'Bins out' },
  project: { kind: 'project', id: 'p1', name: 'Home' },
  calendar: { kind: 'calendar', id: 'c1', url: 'https://example.test/cal.ics' },
  person: { kind: 'person', id: 'pe1', name: 'Mum' },
  place: { kind: 'place', id: 'pl1', name: 'Café', lat: 33.5, lon: -112.07 },
  recipe: { kind: 'recipe', id: 'r1', name: 'Soup' },
  meal: { kind: 'meal', id: 'm1', date: '2026-09-23', slot: 'dinner', title: 'Soup' },
  grocery: { kind: 'grocery', id: 'g1', weekKey: '2026-W39' },
  journal: { kind: 'journal', id: 'journal~2026-09-23~abcd', date: '2026-09-23', body: 'A good day' },
  event: { kind: 'event', id: 'e1', title: 'Dentist', start: '2026-09-23T15:00:00.000Z' },
  habit: { kind: 'habit', id: 'h1', name: 'Walk' },
  routine: { kind: 'routine', id: 'ro1', name: 'Morning' },
  note: { kind: 'note', id: 'n1', title: 'Ideas' },
  garment: { kind: 'garment', id: 'ga1', type: 'top' },
  outfit: { kind: 'outfit', id: 'o1', garmentIds: ['ga1'] },
  wear: { kind: 'wear', id: 'wear~2026-09-23~abcd', date: '2026-09-23' },
  snooze: { kind: 'snooze', id: 'snooze~person~mum', target: 'person', targetId: 'mum', until: '2026-10-01T00:00:00.000Z' },
  message: { kind: 'message', id: 'msg1', body: 'Home by six' },
  chat: { kind: 'chat', id: 'ch1', role: 'you', text: 'What is on today?' },
  account: { kind: 'account', id: 'a1', name: 'Checking' },
  review: { kind: 'review', id: 'rv1', key: '2026-W39' },
  template: { kind: 'template', id: 'tp1', name: 'Move house' },
}

const fixture = (kind: string) => ({ ...ONE_OF_EACH[kind], createdAt: AT, updatedAt: AT })

/** What a newer build might have added: a value of every JSON shape. */
const NEWER = { servesWith: [{ id: 'x', label: 'Bread', n: 2, ok: true, none: null }], rating: 4.5, source: 'the web' }

describe('a field this build does not know', () => {
  it('has a record of every kind to try it on', () => {
    expect(Object.keys(ONE_OF_EACH).sort()).toEqual([...SYNC_KINDS].sort())
  })

  it('survives sanitize, an edit and sanitize again, on every kind', () => {
    for (const kind of SYNC_KINDS) {
      const pulled = sanitizeItem({ ...fixture(kind), ...NEWER })
      expect(pulled, kind).toMatchObject(NEWER)
      // an edit as the app makes one: the record spread, a field changed, stamped newer
      const edited = { ...pulled!, updatedAt: newerStamp(pulled!.updatedAt), notes: 'changed here' } as Item
      expect(sanitizeItem(edited), kind).toMatchObject(NEWER)
    }
  })

  it('is copied, not shared with what it was read from', () => {
    const raw = { ...fixture('recipe'), servesWith: [{ label: 'Bread' }] }
    const out = sanitizeItem(raw) as Recipe & { servesWith: { label: string }[] }
    raw.servesWith[0].label = 'Rice'
    expect(out.servesWith[0].label).toBe('Bread')
  })

  it('keeps whatever fits in the cap, the same ones in any order', () => {
    const big = 'x'.repeat(UNKNOWN_FIELDS_MAX)
    const out = sanitizeItem({ ...fixture('recipe'), aSmall: 'kept', hugeNote: big, zSmall: 'kept too' }) as unknown as Record<string, unknown>
    expect(out.aSmall).toBe('kept')
    expect(out.zSmall).toBe('kept too')
    expect(out.hugeNote).toBeUndefined()
    // two that fit only one at a time: the first by name stays, whichever came first in the row
    const half = 'y'.repeat(UNKNOWN_FIELDS_MAX / 2 + 10)
    const one = sanitizeItem({ ...fixture('recipe'), bNote: half, aNote: half }) as unknown as Record<string, unknown>
    const other = sanitizeItem({ ...fixture('recipe'), aNote: half, bNote: half }) as unknown as Record<string, unknown>
    expect([one.aNote === half, one.bNote === half]).toEqual([true, false])
    expect([other.aNote === half, other.bNote === half]).toEqual([true, false])
    // and all that is carried, measured as JSON, stays within the cap
    const known = JSON.stringify(sanitizeItem(fixture('recipe')))
    expect(JSON.stringify(one).length - known.length).toBeLessThanOrEqual(UNKNOWN_FIELDS_MAX)
  })

  it('is only ever plain JSON', () => {
    class Box {
      v = 1
    }
    const out = sanitizeItem({
      ...fixture('recipe'),
      fn: () => 1,
      notANumber: NaN,
      tooBig: Infinity,
      nothing: undefined,
      when: new Date(AT),
      box: new Box(),
      map: new Map([[1, 2]]),
      count: BigInt(1),
      sym: Symbol('s'),
      deep: JSON.parse('['.repeat(64) + ']'.repeat(64)),
      fine: { nested: [1, 'two', false, null] },
    }) as unknown as Record<string, unknown>
    for (const key of ['fn', 'notANumber', 'tooBig', 'nothing', 'when', 'box', 'map', 'count', 'sym', 'deep']) expect(key in out, key).toBe(false)
    expect(out.fine).toEqual({ nested: [1, 'two', false, null] })
  })
})

describe('a field the kind knows, or one nobody passes on', () => {
  it('keeps the kind’s own answer, even when that answer was to drop it', () => {
    const recipe = sanitizeItem({ ...fixture('recipe'), sourceUrl: 'javascript:alert(1)' }) as Recipe
    expect(recipe.sourceUrl).toBeUndefined()
    const place = sanitizeItem({ ...fixture('place'), lat: 500, lon: 'west' }) as unknown as Record<string, unknown>
    expect(place.lat).toBeUndefined()
    expect(place.lon).toBeUndefined()
    const task = sanitizeItem({ ...fixture('task'), description: 'Tuesday', body: 'a pre-v3 post’s text' }) as unknown as Record<string, unknown>
    expect(task.description).toBe('Tuesday')
    expect(task.body).toBeUndefined()
    const bought = sanitizeItem({ ...fixture('meal'), out: true, sides: [{ title: 'Rice' }] }) as unknown as Record<string, unknown>
    expect(bought.sides).toBeUndefined()
  })

  it('never lets junk under any field a sanitizer reads through', () => {
    // every field each sanitizer looks at, found by watching it read the record
    const junk = { junk: true }
    for (const kind of SYNC_KINDS) {
      const read = new Set<string>()
      const watched = new Proxy(fixture(kind), {
        get(target, key, receiver) {
          if (typeof key === 'string') read.add(key)
          return Reflect.get(target, key, receiver)
        },
      })
      expect(sanitizeItem(watched), kind).not.toBeNull()
      for (const key of read) {
        if (key === 'kind' || key === 'id') continue
        const out = sanitizeItem({ ...fixture(kind), [key]: junk }) as unknown as Record<string, unknown> | null
        expect(out?.[key], `${kind}.${key}`).not.toEqual(junk)
      }
    }
  })

  it('never carries `shared` for a kind that does not know it, nor the server’s annotations', () => {
    const recipe = sanitizeItem({ ...fixture('recipe'), shared: false, syncedAt: AT, ownerId: 'u1' }) as unknown as Record<string, unknown>
    expect('shared' in recipe).toBe(false)
    expect('syncedAt' in recipe).toBe(false)
    expect(recipe.ownerId).toBe('u1')
    // a task knows it, and anything but a boolean is no answer
    const task = sanitizeItem({ ...fixture('task'), shared: 'no' }) as unknown as Record<string, unknown>
    expect(task.shared).toBeUndefined()
  })

  it('refuses a key that reaches a prototype, at the top or inside a value', () => {
    const row = JSON.parse(
      JSON.stringify({ ...fixture('recipe'), safe: 1 })
        .slice(0, -1)
        .concat(',"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":1,"toString":"x","inner":{"__proto__":{"polluted":true}}}'),
    )
    const out = sanitizeItem(row) as unknown as Record<string, unknown>
    expect(out.safe).toBe(1)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'inner']) expect(Object.prototype.hasOwnProperty.call(out, key), key).toBe(false)
    expect(typeof out.toString).toBe('function')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('an older build’s edit of a record a newer build wrote', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-23T10:00:00.000Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries the newer build’s field back to the server', async () => {
    const server = new FakeServer()
    // written by a newer build, with a field this one has never heard of
    server.seed({ ...fixture('recipe'), servesWith: ['Bread'] } as unknown as Item)
    const d = device(server)
    await ready(d)
    const pulled = d.item<Recipe>('r1')!
    expect(pulled).toMatchObject({ servesWith: ['Bread'] })

    d.engine.upsert({ ...pulled, name: 'Tomato soup', updatedAt: newerStamp(pulled.updatedAt) })
    await d.engine.sync()
    await idle(d)
    expect(server.row('r1')).toMatchObject({ name: 'Tomato soup', servesWith: ['Bread'] })
    // and the device's own copy, cache included, still holds it
    await vi.advanceTimersByTimeAsync(300)
    expect(d.snapshot()?.items.find(i => i.id === 'r1')).toMatchObject({ servesWith: ['Bread'] })
  })
})
