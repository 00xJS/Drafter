import { describe, expect, it } from 'vitest'
import { anthropicRequest } from '../../netlify/functions/lib/ai.mjs'

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
