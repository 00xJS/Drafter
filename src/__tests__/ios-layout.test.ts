import { describe, expect, it } from 'vitest'
import { sheetSource } from './source'

/*
 * What an automated WebKit sweep of every screen at 375, 402 and 440pt found
 * on an iPhone, held here in the sheet as each was fixed. The sweep measures
 * them (overflow, clipping, titles out of their header, tap targets); these
 * keep the rules that fixed them from being undone by a later edit.
 */

const css = sheetSource().replace(/\/\*[\s\S]*?\*\//g, '')

/** Each `@media (…) { … }` block whose condition is exactly `query`, by its body. */
const media = (query: string) => {
  const out: string[] = []
  for (let at = css.indexOf(`@media ${query} {`); at >= 0; at = css.indexOf(`@media ${query} {`, at + 1)) {
    let depth = 0
    const open = css.indexOf('{', at)
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(open + 1, i))
        break
      }
    }
  }
  return out
}
const PHONE = '(max-width: 640px)'
/** The declarations of every rule for exactly `selector` in `text`, run together. */
const rule = (text: string, selector: string) =>
  [...text.matchAll(new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'gm'))].map(m => m[1]).join(';')
/** …in a phone block. */
const phone = (selector: string) => media(PHONE).map(b => rule(b, selector)).join(';')

describe('a sheet’s title stays in its header', () => {
  it('gives a compose sheet’s title two lines, then an ellipsis', () => {
    const title = rule(css, '.modal-head-compose h2')
    expect(title).toMatch(/-webkit-line-clamp:\s*2/)
    expect(title).toMatch(/display:\s*-webkit-box/)
    expect(title).toMatch(/overflow:\s*hidden/)
  })

  it('never lets a phone sheet’s header or footer shrink below what they hold', () => {
    // the native header's 80px min-height is a floor, and it replaced the
    // content-sized minimum: a long form squeezed the header to it
    expect(phone('.modal-head,\n  .modal-foot')).toMatch(/flex-shrink:\s*0/)
  })
})

describe('Tasks → List’s toolbar on a phone', () => {
  it('gives the search a line, and the two filters the next, half and half', () => {
    // the priority filter's 0% basis let it into what the search's line left:
    // its chevrons alone at 402pt, "Ar" at 440pt
    expect(phone('.posts-view > .toolbar > .search')).toMatch(/flex:\s*1 1 100%/)
    const filters = phone('.posts-view > .toolbar > select')
    expect(filters).toMatch(/flex:\s*1 1 40%/)
    expect(filters).toMatch(/min-width:\s*0/)
    expect(css).not.toMatch(/select\[aria-label='Filter by priority'\]\s*\{/)
  })
})

describe('Kitchen → Recipes’ Includes chips', () => {
  it('keep to the column, and scroll sideways in it on a phone', () => {
    // as wide as its chips, the row was 1003px in a 343px column: eight of fifteen out of reach
    expect(rule(css, '.recipe-includes')).toMatch(/min-width:\s*0/)
    expect(phone('.recipe-includes > .kind-chips')).toMatch(/min-width:\s*0/)
    expect(phone('.kind-chips')).toMatch(/overflow-x:\s*auto/)
  })
})

describe('a meal slot beside another member’s plan', () => {
  it('puts their plans on a line of their own, under your chooser', () => {
    expect(rule(css, '.meal-household')).toMatch(/flex:\s*1 1 100%/)
  })
})

describe('another member’s work badge', () => {
  it('wraps onto a line of its own, and ellipsises its words where it still does not fit', () => {
    expect(rule(css, '.cal-day-work')).toMatch(/flex-wrap:\s*wrap/)
    const words = rule(css, '.cal-work-words')
    expect(words).toMatch(/text-overflow:\s*ellipsis/)
    expect(words).toMatch(/min-width:\s*0/)
    expect(words).toMatch(/overflow:\s*hidden/)
  })
})

describe('Check in on a phone', () => {
  it('gives each account’s name the row, and its amount the line under it', () => {
    expect(phone('.checkin-field')).toMatch(/grid-template-areas:\s*'name' 'last' 'input'/)
    expect(phone('.checkin-name')).toMatch(/white-space:\s*normal/)
  })
})

const COARSE = '(pointer: coarse)'
/** …in a touch-screen block. */
const touch = (selector: string) => media(COARSE).map(b => rule(b, selector)).join(';')

describe('a finger’s 44pt round the small controls', () => {
  // measured with hit-tests in the sweep: an 18pt task tick, 26pt swatches (18pt
  // in Settings → Calendars), a Stats card's 28pt names and its 32pt ‹ ›, and
  // the buttons that sit in a line of prose at 34-36pt
  const SMALL = ['.tcheck', '.swatch', '.hbars button.stats-hbar-label', '.hbars button.wardrobe-hbar-label', '.chart-head .segmented > .seg', '.period-bar > .btn', '.notes-tool', '.versions > summary', 'p > .btn.subtle', '.person-journal .btn', '.empty .btn']

  it('grows each one’s target to a 44pt square round its middle, and leaves the look alone', () => {
    const block = media(COARSE).find(b => b.includes('.tcheck::after')) ?? ''
    expect(block, 'no touch block for the hit areas').not.toBe('')
    const areas = rule(block, SMALL.map(s => `${s}::after`).join(',\n  '))
    expect(areas).toMatch(/content:\s*''/)
    expect(areas).toMatch(/position:\s*absolute/)
    expect(areas).toMatch(/inset:\s*min\(0px, calc\(50% - 22px\)\)/)
    expect(rule(block, SMALL.join(',\n  '))).toMatch(/position:\s*relative/)
    // only the target grows: nothing in that rule draws
    expect(areas).not.toMatch(/background|border|box-shadow/)
  })

  it('spaces neighbours that would share a square, so a tap never lands on the wrong one', () => {
    expect(touch('.swatches')).toMatch(/gap:\s*18px/)
    expect(touch('.swatches.small .swatch')).toMatch(/width:\s*26px/)
    expect(touch('.hbars.stats-hbars,\n  .hbars.wardrobe-hbars')).toMatch(/gap:\s*16px/)
    // the photo calendar's days clip their photos, so their gap gives them the width
    expect(touch('.photo-cal-head,\n  .photo-cal')).toMatch(/gap:\s*1px/)
    // …each after the rule it changes, which a bare class only outranks by coming later
    const at = (text: string) => css.indexOf(text)
    expect(at('gap: 18px')).toBeGreaterThan(at('.swatches.small .swatch {\n  width: 18px'))
    expect(at('.photo-cal-head,\n.photo-cal {\n  display: grid')).toBeGreaterThan(-1)
    expect(at('.photo-cal {\n    gap: 1px')).toBeGreaterThan(at('.photo-cal-head,\n.photo-cal {\n  display: grid'))
  })

  it('floors the palette’s rows and the tick rows at 44pt under a finger', () => {
    expect(touch('.search-hit')).toMatch(/min-height:\s*var\(--touch\)/)
    expect(touch('.notes-tool')).toMatch(/min-width:\s*var\(--touch\)/)
    expect(css.lastIndexOf('.notes-tool {\n    min-width: var(--touch)')).toBeGreaterThan(css.indexOf('.notes-tool {\n  font-weight: 700'))
    expect(touch('.cal-add')).toMatch(/row-gap:\s*10px/)
    expect(touch('.fin-weekly-on')).toMatch(/min-height:\s*44px/)
    expect(touch('.bill-field > .field-inline,\n  .bill-fields .field-inline')).toMatch(/min-height:\s*44px/)
    expect(touch('.board-add::after')).toMatch(/inset:\s*min\(0px, calc\(50% - 22px\)\)/)
  })

  it('draws a select itself in the app, so it takes the 44pt floor and keeps a ▾', () => {
    const select = phone('html.native select:not([multiple]):not([size])')
    expect(select).toMatch(/-webkit-appearance:\s*none/)
    expect(select).toMatch(/(?<!-)appearance:\s*none/)
    expect(select).toMatch(/min-height:\s*var\(--touch\)/)
    // the ▾ is two gradients in a token, never an image with a colour in it
    expect(select).toMatch(/linear-gradient\(45deg, transparent 50%, var\(--muted\) 50%\)/)
    expect(select).not.toMatch(/url\(/)
  })
})

describe('press and hold in the app', () => {
  it('selects nothing the app draws, and calls out nothing', () => {
    const body = rule(css, 'html.native body')
    expect(body).toMatch(/-webkit-user-select:\s*none/)
    expect(body).toMatch(/-webkit-touch-callout:\s*none/)
    // the web is left alone
    expect(css).not.toMatch(/(?:^|[},])\s*body\s*\{[^}]*user-select:\s*none/m)
  })

  it('keeps what is written selectable: fields, the notes pad, the journal, a chat message', () => {
    const written = rule(css, "html.native input,\nhtml.native textarea,\nhtml.native [contenteditable]:not([contenteditable='false']),\nhtml.native .journal-body,\nhtml.native .chat-bubble,\nhtml.native .ask-answer")
    expect(written).toMatch(/-webkit-user-select:\s*text/)
    expect(written).toMatch(/-webkit-touch-callout:\s*default/)
  })
})

describe('the small ones', () => {
  it('breaks a month pill’s long word where a hyphen goes, and fits “+8 more”', () => {
    const title = phone('.cal-cell .cal-pill-title')
    expect(title).toMatch(/-webkit-hyphens:\s*auto/)
    expect(title).toMatch(/(?<!-)hyphens:\s*auto/)
    // at the pills' own size: at 12px it was cut to "+8 m…"
    expect(phone('.cal-cell .cal-more')).toMatch(/font-size:\s*10px/)
  })

  it('keeps a coming bill’s Autopay whole beside words that give way', () => {
    expect(rule(css, '.bill-copy small.fin-coming-meta')).toMatch(/display:\s*flex/)
    expect(rule(css, '.fin-coming-text')).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule(css, '.fin-coming-meta > .fin-tag')).toMatch(/flex:\s*none/)
  })
})
