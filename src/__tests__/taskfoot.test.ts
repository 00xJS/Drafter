import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

// Cancel and Save live in the compose head so they cannot wrap onto the
// scrolling body. The foot is Delete / Duplicate on a saved task only; the
// ⌘↩ hint stays there and still hides on a phone. The "in <project>" note
// is gone: there is one ongoing project, so it said the same on every task.

const editor = readFileSync(fileURLToPath(new URL('../components/TaskEditor.tsx', import.meta.url)), 'utf8')

describe('task editor footer', () => {
  it('marks the keyboard hint, and names no project', () => {
    expect(editor).toContain('className="muted task-foot-note">⌘↩ to save')
    expect(editor.match(/task-foot-note/g)).toHaveLength(1)
    expect(editor).not.toMatch(/>\s*in \{project/)
  })

  it('hides the hint below the phone breakpoint only', () => {
    expect(sheetSource()).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.task-foot-note\s*\{\s*display:\s*none;/)
  })
})
