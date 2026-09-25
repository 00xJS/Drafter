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
