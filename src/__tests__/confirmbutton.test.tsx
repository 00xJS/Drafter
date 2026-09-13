import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmButton } from '../components/ConfirmButton'

// A server render cannot click, so the armed state is reached by starting in
// it: while `armed.on` is set, the component's one useState answers true.
const armed = vi.hoisted(() => ({ on: false }))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  const useState = ((initial: unknown) => (armed.on ? [true, () => {}] : react.useState(initial))) as unknown as typeof react.useState
  return { ...react, useState }
})

afterEach(() => {
  armed.on = false
})

describe('ConfirmButton can be given a name', () => {
  it('passes ariaLabel through as aria-label', () => {
    const html = renderToStaticMarkup(
      <ConfirmButton ariaLabel="Delete Milk" onConfirm={() => {}}>
        ✕
      </ConfirmButton>,
    )
    expect(html).toBe('<button type="button" class="btn danger" aria-label="Delete Milk">✕</button>')
  })

  it('keeps the name while armed and adds the confirm step, which a screen reader would otherwise never hear', () => {
    armed.on = true
    const html = renderToStaticMarkup(
      <ConfirmButton ariaLabel="Delete Milk" confirmLabel="Sure?" onConfirm={() => {}}>
        ✕
      </ConfirmButton>,
    )
    expect(html).toBe('<button type="button" class="btn danger armed" aria-label="Delete Milk: Sure?">Sure?</button>')
  })

  it('adds no aria-label when it is not given one, armed or not', () => {
    expect(renderToStaticMarkup(<ConfirmButton onConfirm={() => {}}>Delete</ConfirmButton>)).toBe('<button type="button" class="btn danger">Delete</button>')
    armed.on = true
    expect(renderToStaticMarkup(<ConfirmButton onConfirm={() => {}}>Delete</ConfirmButton>)).toBe(
      '<button type="button" class="btn danger armed">Click again to delete</button>',
    )
  })
})
