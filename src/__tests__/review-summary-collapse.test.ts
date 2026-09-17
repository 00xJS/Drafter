import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { wordCount } from '../components/Review'

// The summary card had no way to shut it. That did not matter while a summary
// was 150 words; it mattered a great deal the week one came back as 600 words
// of the model talking to itself, sitting between the week's figures and
// everything the week actually held.

const source = readFileSync(fileURLToPath(new URL('../components/Review.tsx', import.meta.url)), 'utf8')

describe('wordCount', () => {
  it('counts words, not characters, and reads nothing as nothing', () => {
    expect(wordCount('One two three')).toBe(3)
    expect(wordCount('  spaced \n out  ')).toBe(2)
    expect(wordCount('')).toBe(0)
    expect(wordCount('   ')).toBe(0)
  })
})

describe('the summary card', () => {
  it('has a toggle that says which way it goes', () => {
    expect(source).toContain('aria-expanded={summaryOpen}')
    expect(source).toContain("{summaryOpen ? 'Hide' : 'Show'}")
  })

  it('keeps the choice on the device, and opens by default', () => {
    expect(source).toContain("const SUMMARY_KEY = 'drafter:review-summary'")
    // `!== '0'`, not `=== '1'`: a reader who has never touched it sees the summary
    expect(source).toContain("localStorage.getItem(SUMMARY_KEY) !== '0'")
  })

  it('never hides an error behind it — that is the one thing worth reading', () => {
    // the toggle is drawn only when there is no error, and the body is the
    // error or, only when open, the summary
    expect(source).toContain('{!error && (')
    expect(source).toMatch(/error \? <p className="warn">\{error\}<\/p> : summaryOpen &&/)
  })

  it('opens itself when a summary is asked for, so the button is never a no-op', () => {
    expect(source).toContain('if (!summaryOpen) toggleSummary()')
  })

  it('says how much is behind it while it is shut', () => {
    expect(source).toContain("`${wordCount(summary)} ${wordCount(summary) === 1 ? 'word' : 'words'}, hidden`")
  })
})
