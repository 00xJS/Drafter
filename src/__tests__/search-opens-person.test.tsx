import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { People } from '../components/People'
import { NO_PERSON_FILTER } from '../people'
import type { Person } from '../types'

// Picking a person in Cmd/Ctrl+K opens People on its People segment with that
// person's card open, the way picking a place opens its row on Places. It used
// to show People as it was last left, which could be the Places segment, with
// every card shut. Ask Drafter's person sources and a birthday reminder's link
// go the same way. The card is a static render; the tap itself goes through
// the wiring asserted below and was not run in a browser.

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const person = (id: string, name: string): Person => ({ kind: 'person', id, name, color: '#f472b6', group: 'family', createdAt: STAMP, updatedAt: STAMP })
const PEOPLE = [person('mum', 'Mum'), person('sam', 'Sam')]

const render = (openId?: string) =>
  renderToStaticMarkup(<People people={PEOPLE} tasks={[]} filter={NO_PERSON_FILTER} onFilter={noop} onSave={noop} onDelete={noop} onLogVisit={noop} onPlan={noop} onOpenTask={noop} openId={openId} />)

/** Each card as [id, aria-expanded], in list order. */
const cards = (html: string) => [...html.matchAll(/<li id="person-([^"]+)" class="person-row(?: open)?"><button class="person-summary" aria-expanded="(true|false)"/g)].map(m => [m[1], m[2]])

describe('People opens the card asked for', () => {
  it('opens that person’s card with the first paint, and only theirs', () => {
    const shown = cards(render('sam'))
    expect(shown).toHaveLength(2)
    expect(shown).toEqual(expect.arrayContaining([['sam', 'true'], ['mum', 'false']]))
  })

  it('opens none when nobody was asked for, or someone not on this device', () => {
    expect(cards(render()).map(([, open]) => open)).toEqual(['false', 'false'])
    expect(cards(render('gone')).map(([, open]) => open)).toEqual(['false', 'false'])
  })
})

describe('search, Ask and a reminder hand People the person', () => {
  it('opens the People segment with the card, as openPlace does for Places', () => {
    const nav = read('../components/planner/useNavigation.ts')
    expect(nav).toMatch(/const openPerson = \(id\?: string\) => \{\s*if \(id\) setPersonOpenId\(id\)\s*goKeepTab\('people'\)\s*setView\('keep'\)/)
    const screen = read('../components/planner/PeopleScreen.tsx')
    expect(screen).toMatch(/openId=\{personOpenId\}/)
    expect(screen).toMatch(/onOpenConsumed=\{\(\) => setPersonOpenId\(null\)\}/)
  })

  it('is what the palette, Ask Drafter and a ?saw= link call', () => {
    expect(read('../components/Search.tsx')).toMatch(/else if \(h\.kind === 'person'\) onOpenPerson\(h\.person\)/)
    const overlays = read('../components/planner/Overlays.tsx')
    expect(overlays).toMatch(/onOpenPerson=\{person => openPerson\(person\.id\)\}/)
    expect(overlays).not.toMatch(/onOpenPerson=\{\(\) =>/)
    // the routing moved to askRouting.ts in v3.26, so the same citation goes
    // to the same place from Ask Drafter's sheet AND from Home → Chat
    expect(read('../components/planner/askRouting.ts')).toMatch(/doc\.kind === 'person'\) openPerson\(doc\.id\)/)
    expect(overlays).toContain('askDocOpener(p, closeSheet)')
    const links = read('../components/planner/useDeepLinks.ts')
    const saw = links.slice(links.indexOf('if (parsed.saw) {'), links.indexOf('if (parsed.task) {'))
    expect(saw).toMatch(/openPerson\(person\.id\)/)
    expect(saw).not.toMatch(/goKeepTab\('people'\)/)
  })
})
