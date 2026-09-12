import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

// Home → Week stacks the toolbar, You said, the KPI row, the summary and the
// grid of cards. Its only spacing between them is the column gap it shares
// with Today — when the KPI row's own margin was removed, the tiles sat flush
// on the Done card because nothing else spaced them.

const sheet = sheetSource()

describe('Home → Week spacing', () => {
  it('gives the Week view the same column gap as Today, on desktop and phone', () => {
    expect(sheet).toMatch(/\.insights\.today,\s*\.insights\.review\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*16px;/)
    expect(sheet).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.insights\.today,\s*\.insights\.review\s*\{\s*gap:\s*12px;/)
  })

  it('lets no top-level Week block add a margin of its own on top of the gap', () => {
    // the base .toolbar rule carries margin-bottom: 12px, so Week has to zero it
    const toolbar = /\.review \.toolbar\s*\{([^}]*)\}/.exec(sheet)
    expect(toolbar?.[1] ?? '').toMatch(/margin-bottom:\s*0;/)
  })
})
