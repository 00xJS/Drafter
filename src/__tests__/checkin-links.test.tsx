import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useDeepLinks } from '../components/planner/useDeepLinks'
import { CHECK_IN_PREFIX } from '../../shared/domain.mts'
import { plannerSource } from './source'
import type { Task } from '../types'

// The weekly balance check-in is a task, so its reminder is a task's: a banner
// that opens ?task=<id>. Opened like any other it would land in the editor, on
// a task whose whole point is somewhere else — so it opens Finance's Check in
// sheet, and its Done and Tomorrow buttons still do what a task's do.

const STAMP = '2026-09-01T00:00:00.000Z'
const task = (id: string): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], recurrence: { freq: 'weekly' } })
const CHECK_IN = `${CHECK_IN_PREFIX}abc`

function links() {
  const calls: string[] = []
  const log = (name: string) => vi.fn((...args: unknown[]) => void calls.push(`${name} ${JSON.stringify(args)}`))
  const deps = {
    store: { loaded: true, journal: [], tasks: [task(CHECK_IN), task('chore')], people: [], places: [], upsert: log('upsert'), remove: log('remove') },
    showToast: log('toast'),
    setEditor: log('editor'),
    openFinanceCheckIn: log('checkIn'),
    changeStatus: log('changeStatus'),
    defer: log('defer'),
    setView: log('view'),
    goTasksTab: log('tasksTab'),
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

describe('the weekly check-in’s reminder', () => {
  it('opens Finance on Check in, not the editor', () => {
    const { apply, calls } = links()
    apply(`/?task=${encodeURIComponent(CHECK_IN)}`)
    expect(calls).toEqual(['checkIn []'])
  })

  it('still ticks it off from the banner’s Done, as any task’s reminder does', () => {
    const { apply, calls } = links()
    apply(`/?task=${encodeURIComponent(CHECK_IN)}&act=done`, '', true)
    expect(calls).toEqual([`changeStatus ["${CHECK_IN}","done"]`])
  })

  it('leaves every other task’s reminder opening the editor', () => {
    const { apply, calls } = links()
    apply('/?task=chore')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^editor /)
  })

  it('is opened the same way wherever the task is tapped: the shell routes it before the editor', () => {
    // Home, the calendar, the list, search and the hub all open a task through
    // the planner's one openTask, which hands a check-in to Finance
    expect(plannerSource()).toMatch(/openTask: \(t: Task\) => \(isCheckIn\(t\) \? nav\.openFinanceCheckIn\(\) : overlays\.openTask\(t\)\)/)
  })
})
