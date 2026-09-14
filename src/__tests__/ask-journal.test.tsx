import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIError, CLAUDE_ONLY, askDrafter } from '../ai'
import { prepareAsk } from '../ask'
import type { AskDoc, AskSources } from '../ask'
import { AskFailed, AskSheet, askFailure } from '../components/AskSheet'
import type { JournalEntry } from '../types'

// Ask Drafter with the Journal chip on: the question carries journal entries,
// so it goes to Claude alone (/api/ai's journal flag), and when Claude cannot
// take it the sheet says so and offers the question without the journal. A
// server render runs no effects, so the sheet's one call is caught by running
// the effects it registered, by hand, after the render.

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
const prep = (includeJournal: boolean) => prepareAsk('When did I last see Mum?', sources(), { now, tz: 'Europe/London', includeJournal })

describe('prepareAsk says when the journal was searched', () => {
  it('with the chip on, and not with it off', () => {
    expect(prep(true).journal).toBe(true)
    expect(prep(false).journal).toBe(false)
  })
})

describe('askDrafter tells /api/ai when the journal is in it', () => {
  const stub = (answer: Response) => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return answer.clone()
      }),
    )
    return bodies
  }
  const docs = (): AskDoc[] => prep(true).docs

  it('marks the request journal: true, and sends no flag without it', async () => {
    const bodies = stub(Response.json({ text: JSON.stringify({ answer: 'Last month.', cites: [] }) }))
    await askDrafter('When?', docs(), [], { journal: true })
    await askDrafter('When?', docs(), [])
    expect(bodies).toHaveLength(2)
    expect(bodies[0].journal).toBe(true)
    expect('journal' in bodies[1]).toBe(false)
  })

  it('rejects with the status and the code when Claude cannot take it', async () => {
    stub(Response.json({ error: 'This request goes to Claude only, and Claude is not set up on this site.', code: CLAUDE_ONLY }, { status: 501 }))
    const e = await askDrafter('When?', docs(), [], { journal: true }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AIError)
    expect(e).toMatchObject({ status: 501, code: 'claude_only' })
    expect(askFailure((e as Error).message, e)).toEqual({ text: 'With Journal on, Ask uses only Claude, and Claude isn’t set up on this site.', retry: false, withoutJournal: true })
  })
})

describe('what the sheet says when the journal needs Claude', () => {
  it('offers the question without the journal, and a retry only when Claude was there but failed', () => {
    expect(askFailure('Claude could not answer', { status: 502, code: CLAUDE_ONLY })).toEqual({
      text: 'With Journal on, Ask uses only Claude, and Claude couldn’t answer just now.',
      retry: true,
      withoutJournal: true,
    })
    // anything else is worded as before, with no journal offer
    expect(askFailure('The model returned malformed JSON — try again.', { status: 502 })).toEqual({ text: 'Couldn’t write an answer: The model returned malformed JSON — try again.', retry: true })
    expect(askFailure('AI is not configured on this site', { status: 501, code: '' })).toEqual({
      text: 'The assistant isn’t available here, so there’s no written answer — these are the records that match.',
      retry: false,
    })
  })

  it('draws the offer as a button, beside Try again when trying again could help', () => {
    const both = renderToStaticMarkup(<AskFailed text="Claude couldn’t answer" retry withoutJournal onRetry={noop} onWithoutJournal={noop} />)
    expect(both).toContain('>Try again</button>')
    expect(both).toContain('>Ask without the journal</button>')
    const notSetUp = renderToStaticMarkup(<AskFailed text="Claude isn’t set up" retry={false} withoutJournal onRetry={noop} onWithoutJournal={noop} />)
    expect(notSetUp).not.toContain('Try again')
    expect(notSetUp).toContain('>Ask without the journal</button>')
    expect(renderToStaticMarkup(<AskFailed text="Busy" retry onRetry={noop} onWithoutJournal={noop} />)).not.toContain('without the journal')
  })
})

describe('the sheet sends the chip along with its one call', () => {
  const calls: { journal: boolean }[] = []
  const ask = (_q: string, _docs: AskDoc[], _facts: string[], opts: { journal: boolean }) => {
    calls.push(opts)
    return new Promise<never>(() => {})
  }
  const open = (chip: '0' | '1') => {
    calls.length = 0
    const store = new Map<string, string>([['drafter:ask-journal', chip]])
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
    effects.capture = true
    renderToStaticMarkup(<AskSheet initialQuestion="When did I last see Mum?" sources={sources()} tz="Europe/London" now={now} onOpen={noop} onClose={noop} ask={ask} />)
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

  it('asks Claude alone with the chip on', () => {
    expect(open('1')).toEqual([{ journal: true }])
  })

  it('and sends no journal with it off', () => {
    expect(open('0')).toEqual([{ journal: false }])
  })
})
