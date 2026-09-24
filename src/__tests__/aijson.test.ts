import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../api'
import {
  ASK_NUDGE,
  askDrafter,
  draftPlan,
  extractJSON,
  hasWholeJSON,
  parseMealAssist,
  parseReadRecipe,
  parseRecipeSuggestions,
  polishWeekPlan,
  readList,
  readRecipe,
  suggestCatchUp,
  suggestChecklist,
  suggestOuting,
  suggestTags,
} from '../ai'

// "Where should we go?" failed with "The model returned malformed JSON": the
// default NVIDIA model reasons before it answers, a 768-token budget ran out,
// and the reply stopped half-way through its array.
//
// And NVIDIA's JSON mode answers with an object whatever the prompt asks for:
// {"tags": [...]} came back for a prompt that asked for an array, was read as
// the array, and ✨ Suggest tags failed every time with ".filter is not a
// function". Sometimes the object is {"":""}, whole, valid and empty.

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

  it('hasWholeJSON says no to a value with nothing in it, so the retry fires', () => {
    // what NVIDIA's JSON mode answered the chat with: whole, valid and empty
    for (const empty of ['{"":""}', '{}', '[]', '{"answer":"  ","cites":[]}', '{"tags":[]}', '{"a":null}']) expect(hasWholeJSON(empty), empty).toBe(false)
    // a number or a yes/no is something
    for (const said of ['{"n":0}', '{"general":false}', '{"tags":["home"]}']) expect(hasWholeJSON(said), said).toBe(true)
  })
})

describe('readList: the list in a reply, whichever shape it came in', () => {
  it('reads a bare array, and the array an object holds — by its name, or as its only list', () => {
    expect(readList('["home","errands"]', 'tags')).toEqual(['home', 'errands'])
    expect(readList('{"tags":["home","errands"]}', 'tags')).toEqual(['home', 'errands'])
    expect(readList('Sure: ```json\n{"suggestions":["home"],"note":"ok"}\n```', 'tags')).toEqual(['home'])
    expect(readList('{"steps":["a"],"tags":["b"]}', 'tags')).toEqual(['b'])
  })

  it('keeps the whole items of a list cut off mid-way, wrapped or not', () => {
    expect(readList('["home","errands","gar', 'tags')).toEqual(['home', 'errands'])
    expect(readList('{"tags":["home","errands","gar', 'tags')).toEqual(['home', 'errands'])
    expect(readList('{"ideas":[{"title":"A walk","why":"Free"},{"title":"Nop', 'ideas')).toEqual([{ title: 'A walk', why: 'Free' }])
  })

  it('says so, in words the reader can act on, when there is no list — never a TypeError', () => {
    for (const bad of ['{"":""}', '{"tags":"home, errands"}', '{"steps":["a"],"tags":["b"],"x":[]}', 'no json at all', '{"tags":']) {
      expect(() => readList(bad, 'ideas'), bad).toThrow(/try again/)
    }
  })
})

/** The body of each call the app made to /api/ai. */
const bodies = () => vi.mocked(apiFetch).mock.calls.map(c => JSON.parse(String(c[1]!.body)) as { system: string; prompt: string; maxTokens: number; json: boolean; reasoning?: string })

describe('the list calls, as NVIDIA’s JSON mode answers them', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset())

  // ✨ Suggest tags on the real model, 2026-09-23: "$(t).filter is not a function", every time
  it('reads the tags out of the object JSON mode answers with, in one call, with reasoning off', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('{"tags": ["Home", "#errands", "weekend plans"]}'))
    expect(await suggestTags('Pick up the paint')).toEqual(['home', 'errands', 'weekend-plans'])
    expect(bodies()).toHaveLength(1)
    expect(bodies()[0]).toMatchObject({ json: true, reasoning: 'off' })
    // and the prompt asks for that object, since JSON mode answers with one anyway
    expect(bodies()[0].prompt).toContain('{"tags": ["home", "errands"]}')
  })

  it('asks once more after {"":""}, and says so plainly when the second is no list either', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('{"":""}')).mockResolvedValueOnce(reply('{"tags":["garden"]}'))
    expect(await suggestTags('Weed the beds')).toEqual(['garden'])
    expect(bodies()[1].system).toMatch(/JSON only/)
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValue(reply('{"tags":"garden"}'))
    await expect(suggestTags('Weed the beds')).rejects.toThrow('The model didn’t answer with a list — try again.')
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('breaks a task into steps from {"steps": [...]}', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('{"steps": ["Measure the wall", " Buy the paint ", 7]}'))
    expect(await suggestChecklist('Paint the hall', '')).toEqual(['Measure the wall', 'Buy the paint'])
    expect(bodies()[0]).toMatchObject({ reasoning: 'off' })
  })

  it('reads catch-up ideas from {"ideas": [...]}, and drops an idea that is not an object or has no title', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('{"ideas": [{"title":"Call her Sunday","why":"It has been a while"}, "a walk", {"why":"no title"}]}'))
    expect(await suggestCatchUp({ name: 'Mum', group: 'family', recent: [] })).toEqual([{ title: 'Call her Sunday', why: 'It has been a while' }])
  })

  it('reads outing ideas from {"ideas": [...]}', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('{"ideas":[{"title":"Dinner at Nopi","why":"Your favourite","placeName":"nopi"}]}'))
    expect(await suggestOuting({ weekday: 'Saturday', favourites: [], lapsed: [], recent: [], allNames: ['Nopi'] })).toEqual([
      { title: 'Dinner at Nopi', why: 'Your favourite', placeName: 'Nopi' },
    ])
  })
})

describe('every other JSON call checks its shape and says what went wrong', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset())

  it('Ask asks once more after {"":""}, and takes a lone field JSON mode named something else as the answer', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('{"":""}')).mockResolvedValueOnce(reply('{"response":"Nothing is due tomorrow."}'))
    expect(await askDrafter('What is due tomorrow?', [], ['Today is Tuesday.'])).toEqual({ answer: 'Nothing is due tomorrow.', cites: [] })
    expect(bodies()[1].system).toContain(ASK_NUDGE)
    expect(bodies()[1].reasoning).toBe('off')
  })

  it('Ask says there was no answer, rather than showing nothing, when the second is empty too', async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply('{"answer":""}'))
    await expect(askDrafter('What is due tomorrow?', [], ['Today is Tuesday.'])).rejects.toThrow('The model returned no answer — try again.')
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('a plan that comes back as a bare list is read as its tasks; one with no tasks is asked for again, then said plainly', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('[{"title":"Book the venue","offsetDays":3}]'))
    expect(await draftPlan('Throw a party', 'Party')).toMatchObject({ tasks: [{ title: 'Book the venue', offsetDays: 3 }], milestones: [] })
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValue(reply('{"durationDays":30,"tasks":[],"milestones":[]}'))
    await expect(draftPlan('Throw a party', 'Party')).rejects.toThrow('The model returned no tasks — try again.')
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('a week polish with nothing in it is an error to act on, not a polish that changes nothing', async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply('{"dinners":[],"note":"","catchUps":[]}'))
    const input = { nights: [{ date: '2026-09-28', weekday: 'Monday', busy: null, candidates: [{ ref: 'R1', id: 'r1', name: 'Tacos', tags: [], cooked: 2 }] }], people: [], overdue: [] }
    await expect(polishWeekPlan(input)).rejects.toThrow(/nothing for this week — try again/)
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValue(reply('[{"date":"2026-09-28","recipeRef":"R1"}]'))
    await expect(polishWeekPlan(input)).rejects.toThrow(/try again/)
  })

  it('meal ideas and recipe suggestions read an object or a list, and say when nothing came', async () => {
    const offered = { slots: [{ date: '2026-09-28', slot: 'dinner' as const }], recipes: [{ ref: 'R1', name: 'Tacos', tags: [], cookCount: 2, daysSinceCooked: 9 }], places: [] }
    expect(parseMealAssist('[{"date":"2026-09-28","slot":"dinner","recipeRef":"R1"}]', offered)).toEqual({ suggestions: [], note: '' })
    expect(parseRecipeSuggestions('{"":""}', { recipes: [], exclude: [] })).toEqual([])
    expect(parseReadRecipe('["not a recipe"]')).toEqual({ name: '', servings: undefined, ingredients: [], steps: [] })
  })

  it('reading a pasted recipe asks with reasoning off', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('{"name":"Tacos","ingredients":[{"name":"tortillas","qty":8}],"steps":["Warm the tortillas"]}'))
    expect((await readRecipe('Tacos: 8 tortillas. Warm them.')).ingredients).toEqual([{ name: 'tortillas', qty: 8 }])
    expect(bodies()[0]).toMatchObject({ json: true, reasoning: 'off' })
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
  const bodyOf = (call: number) => JSON.parse(String(vi.mocked(apiFetch).mock.calls[call][1]!.body)) as { maxTokens: number; system: string; reasoning?: string }

  beforeEach(() => vi.mocked(apiFetch).mockReset())

  // The retry used to double the room, to 4096 for a call this size — more
  // than the model can write inside the function's 55 seconds. What ran the
  // first try out was the thinking, so the retry asks without it instead.
  it('retries at the same size with reasoning off and a stricter instruction, then uses the whole answer', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(reply('[{"title":"Dinner at Nopi","why":"Your favourite","placeName":"Nop'))
      .mockResolvedValueOnce(reply('[{"title":"Dinner at Nopi","why":"Your favourite","placeName":"Nopi"}]'))
    const ideas = await suggestOuting(input)
    expect(ideas).toEqual([{ title: 'Dinner at Nopi', why: 'Your favourite', placeName: 'Nopi' }])
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(bodyOf(0).reasoning).toBeUndefined()
    expect(bodyOf(1)).toMatchObject({ maxTokens: bodyOf(0).maxTokens, reasoning: 'off' })
    expect(bodyOf(1).system).toMatch(/JSON only/)
  })

  it('asks only once when the first answer is whole', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply('[{"title":"A walk by the river","why":"Free and close"}]'))
    expect(await suggestOuting(input)).toHaveLength(1)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})
