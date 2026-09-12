import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../api'
import { extractJSON, hasWholeJSON, suggestOuting } from '../ai'

// "Where should we go?" failed with "The model returned malformed JSON": the
// default NVIDIA model reasons before it answers, a 768-token budget ran out,
// and the reply stopped half-way through its array.

const reply = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) }) as unknown as Response

describe('extractJSON', () => {
  it('reads JSON inside code fences and chatter', () => {
    expect(extractJSON('Sure! ```json\n[{"a":1}]\n``` Hope that helps')).toEqual([{ a: 1 }])
  })

  it('tolerates a trailing comma', () => {
    expect(extractJSON('{"a":[1,2,],}')).toEqual({ a: [1, 2] })
  })

  it('is not fooled by brackets inside strings, or by a second value after the first', () => {
    expect(extractJSON('[{"t":"a ] b } c"}] and {"x":1}')).toEqual([{ t: 'a ] b } c' }])
  })

  it('keeps the complete items of an array cut off mid-answer', () => {
    expect(extractJSON('[{"title":"Park"},{"title":"Caf')).toEqual([{ title: 'Park' }])
    expect(extractJSON('["walk","swim","ru')).toEqual(['walk', 'swim'])
  })

  it('says so when there is nothing to keep', () => {
    expect(() => extractJSON('no json here')).toThrow(/no JSON/)
    expect(() => extractJSON('{"a":')).toThrow(/cut off/)
  })

  it('hasWholeJSON is true only for a complete, parseable value', () => {
    expect(hasWholeJSON('x [1,2] y')).toBe(true)
    expect(hasWholeJSON('```json\n{"a":1}\n```')).toBe(true)
    expect(hasWholeJSON('[{"a":1},')).toBe(false)
    expect(hasWholeJSON('')).toBe(false)
  })
})

describe('a JSON answer that comes back cut off is asked for once more', () => {
  const input = {
    weekday: 'Saturday',
    favourites: [{ name: 'Nopi', category: 'restaurant', times: 5, lastWent: '2 weeks ago' }],
    lapsed: [],
    recent: [],
    allNames: ['Nopi'],
  }
  const bodyOf = (call: number) => JSON.parse(String(vi.mocked(apiFetch).mock.calls[call][1]!.body)) as { maxTokens: number; system: string }

  beforeEach(() => vi.mocked(apiFetch).mockReset())

  it('retries with more room and a stricter instruction, then uses the whole answer', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(reply('[{"title":"Dinner at Nopi","why":"Your favourite","placeName":"Nop'))
      .mockResolvedValueOnce(reply('[{"title":"Dinner at Nopi","why":"Your favourite","placeName":"Nopi"}]'))
    const ideas = await suggestOuting(input)
    expect(ideas).toEqual([{ title: 'Dinner at Nopi', why: 'Your favourite', placeName: 'Nopi' }])
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).maxTokens).toBeGreaterThan(bodyOf(0).maxTokens)
    expect(bodyOf(1).system).toMatch(/JSON only/)
  })

  it('asks only once when the first answer is whole', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('[{"title":"A walk by the river","why":"Free and close"}]'))
    expect(await suggestOuting(input)).toHaveLength(1)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})
