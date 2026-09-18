import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncCheck } from '../admin'
import { Admin } from '../components/Admin'
import { SyncAlarmBanner, Today } from '../components/Today'
import { SYNC_ALARM_RECENT_MS, SYNC_ALARM_SNOOZE_MS, readSyncAlarmDismissal, syncAlarmOf, writeSyncAlarmDismissal } from '../syncalarm'
import type { Task } from '../types'
import { plannerSource } from './source'

// Q15 (b): the hourly sync check (the canary) tells the owner through the
// digest's push or email, and with both off it only ever showed in Admin →
// Data. Today now says it too, for the owner, in the check's own sentence,
// until dismissed, with the way to that card.

const HOUR = 3_600_000
const NOW = new Date('2026-09-14T09:00:00.000Z')
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString()
const SENTENCE = 'The server refused a test write for habit (rejected), 3 hours ago. First seen 2 days ago.'

const check = (over: Partial<NonNullable<SyncCheck['record']>> = {}, sentence = SENTENCE): SyncCheck => ({
  sentence,
  record: { ok: false, checked: 18, failures: [{ kind: 'habit', reason: 'rejected' }], error: null, at: ago(3), failingSince: ago(50), alertedAt: null, ...over },
})

describe('syncAlarmOf: when Today says anything', () => {
  it('when the latest check found writes refused, in its own sentence', () => {
    expect(syncAlarmOf(check(), NOW)).toEqual({ sentence: SENTENCE, since: ago(50) })
    // the first failing run has no earlier start of its own
    expect(syncAlarmOf(check({ failingSince: null }), NOW)?.since).toBe(ago(3))
  })

  it('never for a passing check, one that has not run, or one that could not run at all', () => {
    expect(syncAlarmOf(null, NOW)).toBeNull()
    expect(syncAlarmOf({ sentence: 'No sync check has run yet.', record: null }, NOW)).toBeNull()
    expect(syncAlarmOf(check({ ok: true, failures: [], failingSince: null }), NOW)).toBeNull()
    // between a deploy and the migration that installs the check, every run looks like this; the alert stays quiet for it too
    expect(syncAlarmOf(check({ failures: [], error: 'rpc/sync_canary: 404' }), NOW)).toBeNull()
  })

  it('only while the check is recent: a stale one means the check stopped, which Admin shows', () => {
    expect(syncAlarmOf(check({ at: new Date(NOW.getTime() - SYNC_ALARM_RECENT_MS).toISOString() }), NOW)).not.toBeNull()
    expect(syncAlarmOf(check({ at: new Date(NOW.getTime() - SYNC_ALARM_RECENT_MS - 1).toISOString() }), NOW)).toBeNull()
    expect(syncAlarmOf(check({ at: 'not a date' }), NOW)).toBeNull()
  })

  it('dismissed, stays away twelve hours while the same failures go on, and at once comes back for new ones', () => {
    const dismissed = { since: ago(50), at: ago(1) }
    expect(syncAlarmOf(check(), NOW, dismissed)).toBeNull()
    expect(syncAlarmOf(check(), new Date(Date.parse(dismissed.at) + SYNC_ALARM_SNOOZE_MS), dismissed)).not.toBeNull()
    expect(syncAlarmOf(check({ failingSince: ago(2) }), NOW, dismissed)).not.toBeNull()
    expect(SYNC_ALARM_SNOOZE_MS).toBe(12 * HOUR)
  })
})

describe('the dismissal is this device’s own note', () => {
  const saved = new Map<string, string>()
  beforeEach(() => {
    saved.clear()
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is kept and read back, and reads as none when it cannot be read', () => {
    expect(readSyncAlarmDismissal()).toBeNull()
    writeSyncAlarmDismissal({ since: ago(50), at: ago(1) })
    expect(readSyncAlarmDismissal()).toEqual({ since: ago(50), at: ago(1) })
    saved.set('drafter:sync-alarm-dismissed', '{"since":3}')
    expect(readSyncAlarmDismissal()).toBeNull()
    vi.stubGlobal('localStorage', undefined)
    expect(readSyncAlarmDismissal()).toBeNull()
    expect(() => writeSyncAlarmDismissal({ since: ago(50), at: ago(1) })).not.toThrow()
  })
})

describe('the banner on Today', () => {
  const noop = () => {}
  const task: Task = { kind: 'task', id: 't', title: 'Put the bins out', description: '', status: 'todo', priority: 'normal', tags: [], createdAt: ago(40), updatedAt: ago(40) }
  const renderToday = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <Today
        tasks={[task]}
        people={[]}
        places={[]}
        reviews={[]}
        onPlanWith={noop}
        onWentTo={noop}
        onPlanAt={noop}
        onPlanOccasion={noop}
        onSaw={noop}
        onSaveReview={noop}
        projects={[]}
        events={[]}
        sourceMap={new Map()}
        onPlan={noop}
        onOpen={noop}
        onStatus={noop}
        onDefer={noop}
        onDeferAll={noop}
        onNew={noop}
        meals={[]}
        recipes={[]}
        onOpenKitchen={noop}
        onOpenReview={noop}
        onCookRecipe={noop}
        journal={[]}
        onSaveJournal={noop}
        onDeleteJournal={noop}
        onOpenJournal={noop}
        habits={[]}
        onSaveHabit={noop}
        onDeleteHabit={noop}
        routines={[]}
        onSaveRoutine={noop}
        onDeleteRoutine={noop}
        {...over}
      />,
    )
  const alarm = { sentence: SENTENCE, since: ago(50) }

  it('says what is wrong in the check’s words, links to Admin → Data, and can be put aside', () => {
    const html = renderToStaticMarkup(<SyncAlarmBanner alarm={alarm} onOpen={noop} onDismiss={noop} />)
    expect(html).toContain('class="sync-alarm" role="status"')
    expect(html).toContain('Some edits are not reaching the server.')
    expect(html).toContain(SENTENCE)
    expect(html).toContain('>Open Admin → Data</button>')
    expect(html).toContain('aria-label="Dismiss the sync alarm"')
  })

  it('tops the page, above the day’s briefing, and the empty page too', () => {
    const html = renderToday({ syncAlarm: alarm, onOpenSyncCheck: noop, onDismissSyncAlarm: noop })
    const banner = html.indexOf('class="sync-alarm"')
    expect(banner).toBeGreaterThan(html.indexOf('class="today-head"'))
    expect(banner).toBeLessThan(html.indexOf('class="chart-card briefing"'))
    const empty = renderToday({ tasks: [], syncAlarm: alarm })
    expect(empty).toContain('Welcome to your planner')
    expect(empty.indexOf('class="sync-alarm"')).toBeLessThan(empty.indexOf('Welcome to your planner'))
  })

  it('is not there without an alarm, as for every account but the owner', () => {
    expect(renderToday()).not.toContain('sync-alarm')
    expect(renderToday({ syncAlarm: null })).not.toContain('sync-alarm')
  })
})

describe('wired for the owner, to Admin on Data', () => {
  it('reads the check for the owner only, and the banner opens Admin on Data', () => {
    const shell = plannerSource()
    expect(shell).toMatch(/const syncAlarm = useSyncAlarm\(owner\.isOwner\)/)
    expect(shell).toMatch(/syncAlarm=\{syncAlarm\}/)
    expect(shell).toMatch(/onOpenSyncCheck=\{\(\) => setAdminOpen\(true, 'data'\)\}/)
    expect(shell).toMatch(/<Admin onClose=\{\(\) => setAdminOpen\(false\)\} initialGroup=\{adminGroup\} \/>/)
    const hook = readFileSync(fileURLToPath(new URL('../components/planner/useSyncAlarm.ts', import.meta.url)), 'utf8')
    expect(hook).toMatch(/if \(!isOwner\) \{\s*setCheck\(null\)\s*return\s*\}/)
  })

  it('Admin opens on the section asked for, and on Users otherwise', () => {
    const tab = (html: string) => /class="seg on"[^>]*>([^<]+)</.exec(html)?.[1]
    expect(tab(renderToStaticMarkup(<Admin onClose={() => {}} initialGroup="data" />))).toBe('Data')
    expect(tab(renderToStaticMarkup(<Admin onClose={() => {}} />))).toBe('Users')
  })
})
