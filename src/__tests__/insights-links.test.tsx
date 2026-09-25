import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PlannerCtx } from '../components/planner/ctx'
import { hubOpener } from '../components/planner/hubRouting'
import { useDeepLinks } from '../components/planner/useDeepLinks'
import { parseLink } from '../links'

// The monthly recap's ways in: its push (`?insights=month&period=2026-09`)
// and its row in the hub (a notice whose target is Insights on that month).
// Either lands on Insights' Highlights on that month, and writes nothing.
// Guarded as the other links are: a period this app does not name is no
// period, a key that is not that period's is the one we are in, and nothing
// opens before the planner has loaded.

function links({ loaded = true } = {}) {
  const calls: string[] = []
  const log = (name: string) => vi.fn((...args: unknown[]) => void calls.push(`${name} ${JSON.stringify(args)}`))
  const deps = {
    store: { loaded, journal: [], tasks: [], people: [], places: [], upsert: log('upsert'), remove: log('remove') },
    showToast: log('toast'),
    setEditor: log('editor'),
    setView: log('view'),
    setPushed: log('pushed'),
    openInsights: log('insights'),
    openLens: log('lens'),
    newTask: log('newTask'),
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

describe('the monthly recap’s push', () => {
  it('opens Insights on the month it names, and nothing more', () => {
    const { apply, calls } = links()
    apply('/?insights=month&period=2026-09')
    expect(calls).toEqual(['insights ["month","2026-09"]'])
  })

  it('opens a week or a year the same way', () => {
    const { apply, calls } = links()
    apply('/?insights=week&period=2026-W38')
    apply('/?insights=year&period=2025')
    expect(calls).toEqual(['insights ["week","2026-W38"]', 'insights ["year","2025"]'])
  })

  it('opens on the period we are in when the key is not one, or not that period’s', () => {
    const { apply, calls } = links()
    apply('/?insights=month&period=2026-13')
    apply('/?insights=week&period=2026-09')
    apply('/?insights=month&period=constructor')
    expect(calls).toEqual(['insights ["month",null]', 'insights ["week",null]', 'insights ["month",null]'])
  })

  it('names no other period, and writes nothing whatever rides along', () => {
    const { apply, calls } = links()
    apply('/?insights=decade&period=2026')
    apply('/?insights=__proto__')
    expect(calls).toEqual([])
    apply('/?insights=month&period=2026-09&act=done', '', true)
    expect(calls).toEqual(['insights ["month","2026-09"]'])
  })

  it('is read only from the app’s own links, never drafter://new', () => {
    expect(parseLink(new URLSearchParams('insights=month&period=2026-09'), { host: 'new' }).insights).toBeUndefined()
    expect(parseLink(new URLSearchParams('insights=month&period=2026-09'), { host: 'open' }).insights).toEqual({ period: 'month', at: '2026-09' })
    expect(parseLink(new URLSearchParams('insights=month&period=2026-09'), { host: 'journal' }).insights).toBeUndefined()
  })

  it('waits, like every link, until the planner has loaded', () => {
    const { apply, calls } = links({ loaded: false })
    apply('/?insights=month&period=2026-09')
    expect(calls).toEqual([])
  })
})

describe('the links to Insights → Stats', () => {
  it('open an area’s figures, the year, or the Highlights for a bare ?view=stats', () => {
    const { apply, calls } = links()
    apply('/?view=stats-people')
    apply('/?view=stats-year')
    apply('/?view=stats')
    expect(calls).toEqual(['lens ["people"]', 'lens ["year"]', 'lens []'])
  })
})

describe('the recap’s row in the hub', () => {
  function opener() {
    const calls: string[] = []
    const p = new Proxy({} as Record<string, unknown>, {
      get: (_, key: string) => (key === 'store' ? { tasks: [], events: [] } : (...args: unknown[]) => void calls.push(`${key} ${JSON.stringify(args)}`)),
    }) as unknown as PlannerCtx
    return { open: hubOpener(p, () => calls.push('closed')), calls }
  }

  it('opens Insights on its month, as its push does, once the sheet is down', () => {
    const { open, calls } = opener()
    open({ kind: 'insights', id: '2026-09' })
    expect(calls).toEqual(['closed', 'openInsights ["month","2026-09"]'])
  })

  it('opens on the month we are in for a key it cannot read', () => {
    const { open, calls } = opener()
    open({ kind: 'insights', id: 'soon' })
    expect(calls).toEqual(['closed', 'openInsights ["month",null]'])
  })
})
