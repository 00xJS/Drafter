import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../api'
import { looksLikeThinking, refineDescription, summarizeReview } from '../ai'

// The week of 2026-09-13 was saved and shown with this as its review:
//
//   "We need to produce a personal review, warm, candid, like a good friend who
//    is also organised. Plain text, short paragraphs, "-" bullets only, no
//    headings… We must avoid headings (like "Completed:" is a heading? …"
//
// 3,625 characters of the model working out how to write a review, cut off
// mid-sentence, because a reasoning model spent all 900 tokens thinking and
// never reached the review. The JSON calls had a guard for exactly this since
// "Where should we go?" came back as half an array; the two plain-text calls
// had none, so nothing noticed and it went into the record.

const reply = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) }) as unknown as Response
const mock = vi.mocked(apiFetch)

const REVIEW_SYSTEM_ECHO =
  'We are writing someone their own review of the period, in the second person: warm, candid, a good friend who is also organised.'

const THE_REAL_THING =
  'You finished eight things this week, which is more than it probably felt like. The BBQ at Tata Marco\'s and Pokémon GO Fest both landed, and you saw Tio Marco, Tata Marco, Nana Amy and Nana Chevy. The report for Invitation Homes slipped again. Next week: get the report sent, book the oil change, and keep one evening clear.'

const reviewInput = {
  period: 'week' as const,
  label: 'Sep 7–13',
  done: ['BBQ at Tata Marco’s House'],
  slipped: ['Report Fixes to Invitation Homes'],
  upcoming: [],
  people: ['Tio Marco ×2'],
}

beforeEach(() => mock.mockReset())

describe('looksLikeThinking', () => {
  it('catches a reply that quotes its own brief back', () => {
    expect(looksLikeThinking(REVIEW_SYSTEM_ECHO, 'You are writing someone their own review of the period, in the second person: warm, candid.')).toBe(true)
  })

  it('leaves a real answer alone', () => {
    expect(
      looksLikeThinking(
        THE_REAL_THING,
        'You are writing someone their own review of the period, in the second person: warm, candid, a good friend who is also organised. Name the tasks and the people.',
      ),
    ).toBe(false)
  })

  it('needs a run of six words, so a phrase the brief and the answer share is not enough', () => {
    // "the tasks and the people" is five, and an answer may well say it
    expect(looksLikeThinking('I named the tasks and the people.', 'Name the tasks and the people in your reply.')).toBe(false)
  })

  it('reads through punctuation and case, which a model does not copy exactly', () => {
    expect(looksLikeThinking('So — PLAIN prose, in short paragraphs, with "-" bullets. Right?', 'Plain prose in short paragraphs with bullets where a list reads better.')).toBe(true)
  })

  it('says no when there is no brief to quote', () => {
    expect(looksLikeThinking('Anything at all.', '')).toBe(false)
    expect(looksLikeThinking('', 'A brief long enough to have six words in it.')).toBe(false)
  })
})

describe('a plain-text call whose reply is the thinking', () => {
  it('asks again without the reasoning, and returns what comes back', async () => {
    mock.mockResolvedValueOnce(reply(REVIEW_SYSTEM_ECHO)).mockResolvedValueOnce(reply(THE_REAL_THING))
    await expect(summarizeReview(reviewInput)).resolves.toBe(THE_REAL_THING)
    expect(mock).toHaveBeenCalledTimes(2)
    const second = JSON.parse(String(mock.mock.calls[1][1]?.body))
    expect(second.system).toContain('no reasoning')
    // and with room, so the second try does not run out the same way
    expect(second.maxTokens).toBeGreaterThanOrEqual(2048)
  })

  it('throws rather than saving the thinking as the review', async () => {
    mock.mockResolvedValue(reply(REVIEW_SYSTEM_ECHO))
    await expect(summarizeReview(reviewInput)).rejects.toThrow(/thought out loud/)
  })

  it('asks once when the first reply is the review', async () => {
    mock.mockResolvedValueOnce(reply(THE_REAL_THING))
    await expect(summarizeReview(reviewInput)).resolves.toBe(THE_REAL_THING)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('guards the other plain-text call too — refining a description', async () => {
    mock
      .mockResolvedValueOnce(reply('You are a precise editor for personal and household project notes, so first I should…'))
      .mockResolvedValueOnce(reply('Call the shop, book the earliest Saturday, and put the receipt in the glovebox.'))
    await expect(refineDescription('clarify', 'Oil change', 'get oil changed')).resolves.toBe(
      'Call the shop, book the earliest Saturday, and put the receipt in the glovebox.',
    )
    expect(mock).toHaveBeenCalledTimes(2)
  })
})
