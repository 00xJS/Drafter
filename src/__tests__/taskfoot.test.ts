import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

// At 375pt the task editor's footer — Delete, Duplicate, the ⌘↩ hint, "in
// <project>", Cancel, Save — wrapped Save onto a second row. On a phone the
// keyboard hint means nothing and the project note is secondary, so both go.

const editor = readFileSync(fileURLToPath(new URL('../components/TaskEditor.tsx', import.meta.url)), 'utf8')

describe('task editor footer on a phone', () => {
  it('marks the two footer notes', () => {
    expect(editor).toContain('className="muted task-foot-note">⌘↩ to save')
    expect(editor).toContain('className="muted task-foot-note">in {project.name}')
  })

  it('hides them below the phone breakpoint only', () => {
    expect(sheetSource()).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.task-foot-note\s*\{\s*display:\s*none;/)
  })
})
