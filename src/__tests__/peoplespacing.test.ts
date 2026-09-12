import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

// People and Places space their blocks with bottom margins; the ideas card
// ("Where should we go?", ✨ Ideas) had none and sat on the row below it.

describe('People and Places spacing', () => {
  it('keeps the ideas card off the search and sort row below it', () => {
    expect(sheetSource()).toMatch(/\.people > \.chart-card\s*\{[^}]*margin-bottom:\s*12px;/)
  })
})
