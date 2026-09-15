import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askDrafter } from '../ai'
import { prepareAsk } from '../ask'
import type { AskDoc, AskSources } from '../ask'
import { ASK_JOURNAL_KEY, AskSheet, askFailure, readAskJournal } from '../components/AskSheet'
import type { JournalEntry } from '../types'

// Ask Drafter's Journal chip: off until it is turned on, remembered on this
// device, and with it on the entries that match are among the records the
// one call sends. That call goes where every other ✨ request goes (the
// provider order in netlify/functions/lib/ai.mjs, pinned by
// ai-journal-routing.test.ts): it carries no flag of its own, and nothing in
// the sheet says the journal needs Claude. A server render runs no effects, so
// the sheet's one call is caught by running the effects it registered, by
// hand, after the render.

const effects = vi.hoisted(() => ({ capture: false, list: [] as (() => unknown)[] }))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  const useEffect = ((effect: () => void, deps?: readonly unknown[]) => {
    if (effects.capture) effects.list.push(effect)
    else react.useEffect(effect, deps)
  }) as typeof react.useEffect
  return { ...react, useEffect }
})

afterEach(() => {
  effects.capture = false
  effects.list = []
  vi.unstubAllGlobals()
})

const noop = () => {}
const STAMP = '2026-01-01T00:00:00.000Z'
const at = (m: number, d: number, h = 9) => new Date(2026, m - 1, d, h, 0).toISOString()
const now = new Date(2026, 8, 12, 10, 0)
const QUESTION = 'When did I last see Mum?'
const sources = (): AskSources => ({
  tasks: [{ kind: 'task', id: 'id-visit', title: 'Lunch with Mum', description: '', status: 'done', priority: 'normal', completedAt: at(8, 1, 13), peopleIds: ['id-mum'], tags: ['visit'], createdAt: STAMP, updatedAt: STAMP }],
  projects: [],
  people: [{ kind: 'person', id: 'id-mum', name: 'Mum', color: '#fff', group: 'family', createdAt: STAMP, updatedAt: STAMP }],
  places: [],
  recipes: [],
  meals: [],
  entries: [],
  feedEvents: [],
  journal: [{ kind: 'journal', id: 'journal~2026-09-10~a', date: '2026-09-10', body: 'Felt great after seeing Mum', createdAt: STAMP, updatedAt: STAMP } as JournalEntry],
})
const prep = (includeJournal: boolean) => prepareAsk(QUESTION, sources(), { now, tz: 'Europe/London', includeJournal })
const journalDocs = (docs: AskDoc[]) => docs.filter(d => d.kind === 'journal')

/** This device's storage, holding the chip as `chip` ('1' on, '0' off, null never set). */
const device = (chip: '0' | '1' | null) => {
  const store = new Map<string, string>(chip === null ? [] : [[ASK_JOURNAL_KEY, chip]])
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
  return store
}

describe('the Journal chip', () => {
  it('is off until it is turned on, and this device remembers it', () => {
    expect(ASK_JOURNAL_KEY).toBe('drafter:ask-journal')
    device(null)
    expect(readAskJournal()).toBe(false)
    device('1')
    expect(readAskJournal()).toBe(true)
    device('0')
    expect(readAskJournal()).toBe(false)
  })

  it('says what it does, and nothing about Claude', () => {
    const sheet = (chip: '0' | '1') => {
      device(chip)
      return renderToStaticMarkup(<AskSheet sources={sources()} tz="Europe/London" now={now} onOpen={noop} onClose={noop} ask={() => new Promise<never>(() => {})} />)
    }
    const on = sheet('1')
    expect(on).toContain('aria-pressed="true"')
    expect(on).toContain('Your journal entries are searched too.</small>')
    expect(on).toContain('and the journal only with the chip on.</p>')
    const off = sheet('0')
    expect(off).toContain('aria-pressed="false"')
    expect(off).toContain('Journal off: your entries stay out of it.')
    for (const html of [on, off]) expect(html).not.toMatch(/Claude|NVIDIA/)
  })
})

describe('prepareAsk searches the journal only with the chip on', () => {
  it('and says nothing about where the question goes', () => {
    expect(journalDocs(prep(true).docs).map(d => d.id)).toEqual(['journal~2026-09-10~a'])
    expect(journalDocs(prep(false).docs)).toEqual([])
    expect(Object.keys(prep(true)).sort()).toEqual(['docs', 'facts', 'journalHint', 'question'])
  })
})

describe('askDrafter sends the journal as it sends any record', () => {
  it('with no flag to route it, chip or not', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ text: JSON.stringify({ answer: 'Last month.', cites: [] }) })
      }),
    )
    const docs = prep(true).docs
    await askDrafter(QUESTION, docs, [])
    expect(bodies).toHaveLength(1)
    expect(Object.keys(bodies[0]).sort()).toEqual(['json', 'maxTokens', 'prompt', 'system'])
    expect(bodies[0].prompt).toContain(journalDocs(docs)[0].ref)
  })
})

describe('what the sheet says when no answer came', () => {
  it('is what it says for any question: never that the journal needs Claude, and no offer to ask without it', () => {
    expect(askFailure('NVIDIA rate limit hit (the free tier is about 40 requests a minute) — wait a moment and retry.')).toEqual({ text: 'Drafter’s assistant is busy — try again in a minute.', retry: true })
    expect(askFailure('AI is not configured on this site: set NVIDIA_API_KEY (or ANTHROPIC_API_KEY) in the host environment.')).toEqual({
      text: 'The assistant isn’t available here, so there’s no written answer — these are the records that match.',
      retry: false,
    })
    expect(askFailure('NVIDIA API error (HTTP 500)')).toEqual({ text: 'Couldn’t write an answer: NVIDIA API error (HTTP 500)', retry: true })
  })
})

describe('the sheet’s one call', () => {
  const open = (chip: '0' | '1') => {
    const calls: unknown[][] = []
    const ask = (...args: unknown[]) => {
      calls.push(args)
      return new Promise<never>(() => {})
    }
    device(chip)
    effects.capture = true
    renderToStaticMarkup(<AskSheet initialQuestion={QUESTION} sources={sources()} tz="Europe/London" now={now} onOpen={noop} onClose={noop} ask={ask} />)
    effects.capture = false
    for (const effect of effects.list) {
      try {
        effect()
      } catch {
        /* the modal's own effects want a document */
      }
    }
    return calls
  }

  it('carries the matching entries with the chip on, and only the question, records and facts', () => {
    const calls = open('1')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(3)
    expect(journalDocs(calls[0][1] as AskDoc[]).map(d => d.id)).toEqual(['journal~2026-09-10~a'])
  })

  it('and none with it off', () => {
    const calls = open('0')
    expect(calls).toHaveLength(1)
    expect(journalDocs(calls[0][1] as AskDoc[])).toEqual([])
  })
})
