import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PersonRow } from '../components/People'
import { personStats } from '../people'
import { placesWith } from '../places'
import type { Person, Place, Task } from '../types'
import { fmtDate } from '../utils'

// A person's card lists "Where we go". Each chip opens that place: People →
// Places, with its row open, the way search opens one. The row's detail is a
// static render here; the tap itself was checked in the browser.

const STAMP = '2026-01-01T00:00:00.000Z'
const NOW = new Date(2026, 8, 12, 12)
const noop = () => {}
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const text = (html: string) => html.replace(/<!-- -->/g, '')

const mum: Person = { kind: 'person', id: 'mum', name: 'Mum', color: '#f472b6', group: 'family', createdAt: STAMP, updatedAt: STAMP }
const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })
const nopi = place('nopi', 'Nopi', { emoji: '🍝' })
const park = place('park', 'Hyde Park', { category: 'outdoors' })
const outing = (id: string, placeId: string, day: number): Task => ({
  kind: 'task',
  id,
  title: 'Out with Mum',
  description: '',
  status: 'done',
  priority: 'normal',
  tags: ['visit'],
  peopleIds: ['mum'],
  placeId,
  completedAt: new Date(2026, 8, day, 13).toISOString(),
  createdAt: STAMP,
  updatedAt: STAMP,
})
const tasks = [outing('t1', 'nopi', 5), outing('t2', 'nopi', 10), outing('t3', 'park', 1)]

const row = (over: Partial<ComponentProps<typeof PersonRow>> = {}) =>
  text(
    renderToStaticMarkup(
      <PersonRow
        stats={personStats(mum, tasks, NOW)}
        open
        onToggle={noop}
        onEdit={noop}
        onLog={noop}
        onPlan={noop}
        onOpenTask={noop}
        placesTogether={placesWith('mum', [nopi, park], tasks)}
        {...over}
      />,
    ),
  )

describe('a person’s Where we go', () => {
  it('makes each place a button that opens it, most visited first', () => {
    const html = row({ onOpenPlace: noop })
    const lastNopi = fmtDate(tasks[1].completedAt)
    expect(html).toContain(`<button type="button" class="toggle on" title="Last ${lastNopi} · open in Places">🍝 Nopi<small class="muted"> ×2</small></button>`)
    expect(html).toContain(`title="Last ${fmtDate(tasks[2].completedAt)} · open in Places">Hyde Park<small class="muted"> ×1</small></button>`)
    expect(html.indexOf('Nopi<small')).toBeLessThan(html.indexOf('Hyde Park<small'))
    expect(html).not.toContain('cursor:default')
  })

  it('reads as it did where nothing can open a place', () => {
    const html = row()
    expect(html).toContain(`<span class="toggle on" style="cursor:default" title="Last ${fmtDate(tasks[1].completedAt)}">🍝 Nopi<small class="muted"> ×2</small></span>`)
    expect(html).not.toContain('open in Places')
  })

  it('is wired to Places with that row open, as search opens a place', () => {
    const screen = read('../components/planner/PeopleScreen.tsx')
    expect(screen).toMatch(/onOpenPlace=\{place => openPlace\(place\.id\)\}/)
    // openPlace hands the row to Places (its openId) and moves the segment
    const nav = read('../components/planner/useNavigation.ts')
    expect(nav).toMatch(/const openPlace = \(id\?: string\) => \{\s*if \(id\) setPlaceOpenId\(id\)\s*goKeepTab\('places'\)/)
    expect(screen).toMatch(/openId=\{placeOpenId\}/)
  })
})
