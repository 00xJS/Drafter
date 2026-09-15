import { describe, expect, it } from 'vitest'
import { allowedAttributes } from '../richtext'

// sanitizeHtml needs a DOMParser, which vitest's node has not got; the subset
// it keeps is read through allowedAttributes, so that is what these pin.
describe('allowedAttributes', () => {
  it('reads the subset by its own tags only, so an element named after something every object inherits is unwrapped, not kept', () => {
    // a note an assistant wrote with <constructor title="x"> used to throw in
    // sanitizeHtml, and every sync that pulled it threw with it
    for (const tag of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'span', 'script', '']) expect(allowedAttributes(tag), tag).toBeNull()
  })

  it('keeps what each tag in the subset may carry', () => {
    expect(allowedAttributes('p')).toEqual([])
    expect(allowedAttributes('a')).toEqual(['href'])
    expect(allowedAttributes('img')).toEqual(['data-media', 'alt'])
    expect(allowedAttributes('input')).toEqual(['type', 'checked'])
    expect(allowedAttributes('ul')).toEqual(['class'])
  })
})
