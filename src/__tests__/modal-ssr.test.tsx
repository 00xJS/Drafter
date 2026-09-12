import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Modal, ModalHead } from '../components/Modal'

// Modal remembers what had focus while it first renders, so it can hand focus
// back on close. That read must not assume a document: a static render (the
// consent sheet's test, any future server render) has none, and it threw.

describe('Modal without a document', () => {
  it('renders a named dialog in a static render', () => {
    const html = renderToStaticMarkup(
      <Modal onClose={() => {}}>
        <ModalHead title="Settings" />
        <p>body</p>
      </Modal>,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toMatch(/aria-labelledby="[^"]+"/)
    expect(html).toContain('Settings')
  })
})
