import { describe, expect, it, vi } from 'vitest'
import { anthropicRequest, completeNvidia } from '../../netlify/functions/lib/ai.mjs'

// Anthropic is the backup for when NVIDIA is rate-limited or down, so this path
// runs rarely and a bad request shape can hide for weeks — it did: every JSON
// call sent temperature, which current Claude models answer with a 400. These
// pin the shape without a network call.

const base = { system: 'Suggest tags.', prompt: 'Buy paint', maxTokens: 300 }

describe('the Anthropic backup request', () => {
  it('never sends temperature', () => {
    for (const json of [true, false]) {
      for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5']) {
        expect(anthropicRequest({ ...base, json, model })).not.toHaveProperty('temperature')
      }
    }
  })

  it('asks for JSON in words instead', () => {
    expect(anthropicRequest({ ...base, json: true, model: 'claude-opus-5' }).system).toBe(
      'Suggest tags.\n\nRespond with valid JSON only.',
    )
    expect(anthropicRequest({ ...base, system: '', json: true, model: 'claude-opus-5' }).system).toBe(
      'Respond with valid JSON only.',
    )
  })

  it('omits an empty system prompt rather than sending one', () => {
    expect(anthropicRequest({ ...base, system: '', model: 'claude-opus-5' })).not.toHaveProperty('system')
  })

  it('leaves room for thinking, which counts against max_tokens', () => {
    expect(anthropicRequest({ ...base, model: 'claude-opus-5' }).max_tokens).toBe(8000)
    expect(anthropicRequest({ ...base, maxTokens: 12000, model: 'claude-opus-5' }).max_tokens).toBe(12000)
  })

  it('runs these short calls at low effort, only on models that take effort', () => {
    expect(anthropicRequest({ ...base, model: 'claude-opus-5' }).output_config).toEqual({ effort: 'low' })
    expect(anthropicRequest({ ...base, model: 'claude-sonnet-4-6' }).output_config).toEqual({ effort: 'low' })
    expect(anthropicRequest({ ...base, model: 'claude-haiku-4-5' })).not.toHaveProperty('output_config')
  })

  it('opts Opus 5 into server-side refusal fallbacks, and no model that lacks them', () => {
    const opus = anthropicRequest({ ...base, model: 'claude-opus-5' })
    expect(opus.fallbacks).toBe('default')
    expect(opus.betas).toEqual(['server-side-fallback-2026-07-01'])
    const haiku = anthropicRequest({ ...base, model: 'claude-haiku-4-5' })
    expect(haiku).not.toHaveProperty('fallbacks')
    expect(haiku).not.toHaveProperty('betas')
  })
})

describe('the NVIDIA request', () => {
  // Plain text used to keep its own budget, on the reasoning that prose has no
  // shape to break. It breaks worse: the week's review asked for 900 tokens,
  // the model spent all of them thinking about how to write a review, and the
  // thinking is what was saved and shown as the review.
  it('gives every call room to reason before it answers, whatever shape the answer takes', async () => {
    const bodies: { max_tokens: number }[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), { status: 200 })
    })
    process.env.NVIDIA_API_KEY = 'test-key'
    try {
      await completeNvidia({ system: 's', prompt: 'p', maxTokens: 300, json: true })
      await completeNvidia({ system: 's', prompt: 'p', maxTokens: 900, json: false })
      await completeNvidia({ system: 's', prompt: 'p', maxTokens: 4096, json: false })
      expect(bodies[0].max_tokens).toBe(2048)
      expect(bodies[1].max_tokens).toBe(2048)
      // a budget above the floor is the caller's, and stands
      expect(bodies[2].max_tokens).toBe(4096)
    } finally {
      vi.unstubAllGlobals()
      delete process.env.NVIDIA_API_KEY
    }
  })

  it('strips tagged thinking, closed or cut off, whichever wrapper the model used', async () => {
    const replies = [
      '<think>Let me work this out.</think>The answer.',
      '<thinking>Still going</thinking>\nThe answer.',
      '<reasoning>Hmm</reasoning> The answer.',
      '◁think▷weighing it◁/think▷The answer.',
      // the budget ran out mid-thought, so the close never arrived
      '<think>I should start by considering',
    ]
    process.env.NVIDIA_API_KEY = 'test-key'
    try {
      for (const content of replies) {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }))
        const { text } = await completeNvidia({ system: 's', prompt: 'p', maxTokens: 300 })
        expect(text).toBe(content.startsWith('<think>I should') ? '' : 'The answer.')
      }
    } finally {
      vi.unstubAllGlobals()
      delete process.env.NVIDIA_API_KEY
    }
  })
})
