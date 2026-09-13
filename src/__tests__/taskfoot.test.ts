import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

// At 375pt the task editor's footer — Delete, Duplicate, the ⌘↩ hint, Cancel,
// Save — wrapped Save onto a second row. On a phone the keyboard hint means
// nothing, so it goes. The "in <project>" note that sat beside it is gone on
// every screen: there is one ongoing project, so it said the same on every task.

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
