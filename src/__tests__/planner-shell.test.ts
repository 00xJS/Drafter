import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/*
 * Planner.tsx was 1,700 lines holding every tab, editor, toast and link. It is
 * now the shell that calls the planner/ hooks and lays out the page; what it
 * rendered inline lives in components/planner/. This keeps it that way.
 */
describe('the shell stays a shell', () => {
  it('keeps Planner.tsx under 300 lines', () => {
    expect(read('../components/Planner.tsx').split('\n').length).toBeLessThan(300)
  })
})

const topBar = read('../components/planner/TopBar.tsx')
const calendar = read('../components/planner/CalendarScreen.tsx')
const people = read('../components/planner/PeopleScreen.tsx')

describe('the tabs and segments say where you are', () => {
  it('marks the desktop strip like the phone bar: real buttons, the current tab current', () => {
    const strip = topBar.slice(topBar.indexOf('<nav className="tabs tabs-full"'), topBar.indexOf('<nav className="tabs tabs-compact"'))
    expect(strip).toMatch(/type="button"/)
    expect(strip).toMatch(/aria-current=\{view === v \? 'page' : undefined\}/)
    expect(strip).toMatch(/onClick=\{\(\) => goView\(v\)\}/)
  })

  it('gives the calendar mode control tabs that say which one is on', () => {
    const modes = calendar.slice(calendar.indexOf('className="segmented cal-mode"'), calendar.indexOf('</div>'))
    expect(modes).toMatch(/role="tablist" aria-label="Calendar mode"/)
    for (const mode of ['month', 'week', 'timeline']) expect(modes).toMatch(new RegExp(`type="button" role="tab" aria-selected=\\{calMode === '${mode}'\\}`))
  })

  it('makes People / Places a tablist, like Home and Tasks', () => {
    expect(people).toMatch(/<span className="segmented" role="tablist" aria-label="People view">/)
    expect(people.match(/role="tab"/g)).toHaveLength(2)
    expect(people).toMatch(/aria-selected=\{peopleTab === 'people'\}/)
    expect(people).toMatch(/aria-selected=\{peopleTab === 'places'\}/)
  })

  it('leaves both tab bars without haptics', () => {
    const bars = topBar.slice(topBar.indexOf('<nav className="tabs tabs-full"'), topBar.indexOf('<span className="spacer" />'))
    expect(bars).not.toMatch(/haptic/)
  })
})

describe('the sync pill', () => {
  const pill = topBar.slice(topBar.indexOf('className="sync-btn"'), topBar.indexOf('</button>', topBar.indexOf('className="sync-btn"')))

  it('says the data stays on this device when there is no account to sync with', () => {
    // local mode (no Supabase env) has nothing to sync: "Offline — tap to retry" was untrue
    expect(pill).toMatch(/!isSupabaseConfigured\(\)\s*\?\s*'Stored on this device[^']*'/)
    expect(pill).toContain("'Synced — tap to sync now'")
    expect(pill).toContain("'Offline — tap to retry'")
  })

  it('keeps the visible label as it was', () => {
    expect(pill).toMatch(/\{syncing \? 'Syncing…' : store\.syncInfo\.pending \? `\$\{store\.syncInfo\.pending\} unsynced` : store\.syncInfo\.lastAt \? timeAgo\(store\.syncInfo\.lastAt\)\.replace\(' ago', ''\) : 'sync'\}/)
  })
})
