import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useDeepLinks } from '../components/planner/useDeepLinks'
import type { Task } from '../types'

// The ways into the daily routines: plan= links — the morning digest, a
// Shortcut's drafter://open?plan=day — open a sheet and write nothing, and
// Today is handed what it needs to open both sheets and make the focus card's
// and the meal ideas' own moves. The palette's commands are in commands.test.ts.

const STAMP = '2026-09-01T00:00:00.000Z'
const task = (id: string): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [] })

/**
 * useDeepLinks over stand-ins that log every call, so anything that writes
 * shows up. react-dom/server runs the hook's body; its effects are not needed.
 */
function links() {
  const calls: string[] = []
  const log = (name: string) => vi.fn((...args: unknown[]) => void calls.push(`${name} ${JSON.stringify(args)}`))
  const store = {
    loaded: true,
    journal: [],
    tasks: [task('t1')],
    people: [],
    places: [],
    upsert: log('upsert'),
    remove: log('remove'),
    restore: log('restore'),
    purge: log('purge'),
    setStatus: log('setStatus'),
  }
  const deps = {
    store,
    showToast: log('toast'),
    setSettingsNonce: log('settingsNonce'),
    setSettingsOpen: log('settings'),
    setAdminOpen: log('admin'),
    setEditor: log('editor'),
    newTask: log('newTask'),
    openSheet: log('openSheet'),
    goTasksTab: log('tasksTab'),
    goKeepTab: log('keepTab'),
    openStats: log('stats'),
    setHomeTab: log('homeTab'),
    setView: log('view'),
    openJournal: log('journal'),
      openReview: log('review'),
    openPlace: log('place'),
    openWardrobe: log('wardrobe'),
    changeStatus: log('changeStatus'),
    defer: log('defer'),
  } as unknown as Parameters<typeof useDeepLinks>[0]
  let apply: (raw: string, host?: string, fromNotification?: boolean) => void = () => {}
  function Shell() {
    const { applyLinkRef } = useDeepLinks(deps)
    apply = (raw, host, fromNotification) => applyLinkRef.current(raw, host, fromNotification)
    return null
  }
  renderToString(<Shell />)
  return { apply, calls }
}
/** Every stand-in that writes, or offers to. */
const WRITES = /^(upsert|remove|restore|purge|setStatus|changeStatus|defer|toast|editor|newTask) /

describe('plan= links open a sheet and write nothing (B5)', () => {
  it('plan=day opens Plan my day over the day', () => {
    const { apply, calls } = links()
    apply('/?plan=day')
    expect(calls).toEqual(['homeTab ["today"]', 'view ["home"]', 'openSheet [{"kind":"day"}]'])
  })

  it('drafter://open?plan=day and plan=shutdown open their sheets', () => {
    const a = links()
    a.apply('drafter://open?plan=day')
    expect(a.calls).toContain('openSheet [{"kind":"day"}]')
    const b = links()
    b.apply('drafter://open?plan=shutdown')
    expect(b.calls).toEqual(['homeTab ["today"]', 'view ["home"]', 'openSheet [{"kind":"shutdown"}]'])
  })

  it('keeps the view a link names, under the sheet', () => {
    const { apply, calls } = links()
    apply('/?view=calendar&plan=shutdown')
    expect(calls).toEqual(['view ["calendar"]', 'openSheet [{"kind":"shutdown"}]'])
  })

  it('plan=week opens Plan next week over Insights’ Review', () => {
    const a = links()
    a.apply('/?plan=week')
    expect(a.calls).toEqual(['review []', 'openSheet [{"kind":"week"}]'])
    const b = links()
    b.apply('/?view=review&plan=week')
    expect(b.calls).toEqual(['review []', 'openSheet [{"kind":"week"}]'])
  })

  it('writes nothing, even beside a notification’s action on a task', () => {
    for (const [raw, fromNotification] of [
      ['/?plan=day', false],
      ['drafter://open?plan=shutdown', false],
      ['/?view=review&plan=week', false],
      ['/?plan=day&task=t1&act=done', true],
      ['/?plan=shutdown&task=t1&act=tomorrow', true],
    ] as const) {
      const { apply, calls } = links()
      apply(raw, '', fromNotification)
      expect(calls.filter(c => WRITES.test(c)), raw).toEqual([])
    }
  })

  it('is a capture on drafter://new, never a plan', () => {
    const { apply, calls } = links()
    apply('drafter://new?plan=day')
    expect(calls.filter(c => c.startsWith('openSheet'))).toEqual([])
  })
})

describe('a Stats view has a link, as the wardrobe has ?view=wardrobe', () => {
  it('?view=places-stats opens People → Places on its Stats, for the visit, and writes nothing', () => {
    for (const raw of ['/?view=places-stats', 'drafter://open?view=places-stats']) {
      const { apply, calls } = links()
      apply(raw)
      expect(calls, raw).toEqual(['stats ["places"]'])
    }
  })

  it('?view=wardrobe-stats hands Home → Wardrobe its Stats, for the visit, and writes nothing', () => {
    for (const [raw, fromNotification] of [
      ['/?view=wardrobe-stats', false],
      ['drafter://open?view=wardrobe-stats', false],
      ['/?view=wardrobe-stats', true],
    ] as const) {
      const { apply, calls } = links()
      apply(raw, '', fromNotification)
      expect(calls, raw).toEqual(['wardrobe [{"tab":"stats"}]'])
    }
  })

  it('leaves ?view=wardrobe naming no view of the Wardrobe’s, so it opens on today’s composer', () => {
    // It is handed in as a way IN — `{}`, naming nothing — rather than just
    // switching tabs. Since v3.29 the Wardrobe is a segment of Keep that may
    // already be mounted on Clothes, where "switch to it" would land you on
    // whatever you were last looking at; the empty one-shot says composer.
    for (const raw of ['/?view=wardrobe', 'drafter://open?view=wardrobe']) {
      const { apply, calls } = links()
      apply(raw)
      expect(calls, raw).toEqual(['wardrobe [{}]'])
    }
  })

  it('leaves ?tab=places on whichever half Places was showing', () => {
    const { apply, calls } = links()
    apply('/?tab=places')
    expect(calls).toEqual(['keepTab ["places"]', 'view ["keep"]'])
  })
})

describe('a view name is read from its own tables only', () => {
  it('opens nothing for a name every object inherits', () => {
    for (const raw of ['/?view=constructor', '/?view=toString', 'drafter://open?view=__proto__']) {
      const { apply, calls } = links()
      apply(raw)
      expect(calls, raw).toEqual([])
    }
  })
})

describe('Today is handed the routines (B4)', () => {
  const home = readFileSync(fileURLToPath(new URL('../components/planner/HomeScreen.tsx', import.meta.url)), 'utf8')

  it('passes whose focus is whose, the time blocks, both sheets and the cards’ own moves', () => {
    for (const prop of [
      'myId={household.myId}',
      'entries={store.events}',
      "onPlanDay={step => openSheet({ kind: 'day', step })}",
      "onShutDown={() => openSheet({ kind: 'shutdown' })}",
      'onOpenTasks={() => setView(\'tasks\')}',
      "onPlanWeek={() => openSheet({ kind: 'week' })}",
      'onDeferFromFocus={deferFromFocus}',
      'onPlanMeal={planMealIdea}',
    ])
      expect(home).toContain(prop)
  })
})
