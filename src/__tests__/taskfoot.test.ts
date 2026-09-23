import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

// Cancel and Save live in the compose head so they cannot wrap onto the
// scrolling body. The foot is Delete / Duplicate on a saved task only; the
// ⌘↩ hint stays there and still hides on a phone. The "in <project>" note
// is gone: there is one ongoing project, so it said the same on every task.
// The editor draws the hint, marked, and no project: taskeditor.dom.test.tsx.

describe('task editor footer', () => {
  it('hides the hint below the phone breakpoint only', () => {
    expect(sheetSource()).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.task-foot-note\s*\{\s*display:\s*none;/)
  })
})
