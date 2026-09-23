import { afterEach, describe, expect, it, vi } from 'vitest'

// A note is always editable, so a tap on a link in it places the caret — and
// on a phone that was the end of it: links opened only on Cmd/Ctrl+click. A
// tap that lands on a link with nothing selected now offers an Open ↗ under
// it, which opens the page in Safari's sheet in the app (a new tab on the web)
// and an email address in the mail app.

const env = vi.hoisted(() => ({ native: false, opened: [] as string[] }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') },
  registerPlugin: () => ({}),
}))
vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: async ({ url }: { url: string }) => {
      env.opened.push(url)
    },
  },
}))

import { linkTipPlace, openNoteLink, readLinkTap } from '../components/RichNotes'

/** Where a tap lands: an element whose nearest link has this href, or no link at all. */
const landedOn = (href: string | null) =>
  ({ closest: (selector: string) => (href !== null && selector === 'a[href]' ? { getAttribute: (name: string) => (name === 'href' ? href : null) } : null) }) as unknown as EventTarget
const plain = { metaKey: false, ctrlKey: false }
const PAGE = 'https://example.com/hinges'

afterEach(() => {
  env.native = false
  env.opened = []
  vi.unstubAllGlobals()
})

describe('a tap in a note', () => {
  it('on a link, with nothing selected, offers that link', () => {
    expect(readLinkTap(landedOn(PAGE), plain, true)).toEqual({ href: PAGE, open: false })
    expect(readLinkTap(landedOn('mailto:dave@example.com'), plain, true)).toEqual({ href: 'mailto:dave@example.com', open: false })
  })

  it('on a link with some of it selected is editing it: nothing is offered', () => {
    expect(readLinkTap(landedOn(PAGE), plain, false)).toBeNull()
  })

  it('opens at once with Cmd or Ctrl held, as it always did on a computer', () => {
    expect(readLinkTap(landedOn(PAGE), { metaKey: true, ctrlKey: false }, true)).toEqual({ href: PAGE, open: true })
    expect(readLinkTap(landedOn(PAGE), { metaKey: false, ctrlKey: true }, false)).toEqual({ href: PAGE, open: true })
  })

  it('anywhere but a link offers nothing, and neither does a link the sanitizer would not keep', () => {
    expect(readLinkTap(landedOn(null), plain, true)).toBeNull()
    expect(readLinkTap(null, plain, true)).toBeNull()
    expect(readLinkTap(landedOn('javascript:alert(1)'), plain, true)).toBeNull()
    expect(readLinkTap(landedOn(''), { metaKey: true, ctrlKey: false }, true)).toBeNull()
  })
})

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRectReadOnly

describe('where the Open ↗ goes', () => {
  // the pad (the whole notes block), the text inside it, and a link in the text
  const pad = rect(10, 100, 360, 600)
  const text = rect(10, 140, 360, 500)

  it('just under the link, measured from the pad', () => {
    expect(linkTipPlace(rect(40, 300, 120, 20), pad, text)).toEqual({ top: 224, left: 30 })
  })

  it('never off the pad’s right edge, nor its left', () => {
    expect(linkTipPlace(rect(330, 300, 60, 20), pad, text, 96)).toEqual({ top: 224, left: 264 })
    expect(linkTipPlace(rect(0, 300, 60, 20), pad, text)).toMatchObject({ left: 0 })
  })

  it('nowhere once the link has scrolled out of the text', () => {
    expect(linkTipPlace(rect(40, 110, 120, 20), pad, text)).toBeNull()
    expect(linkTipPlace(rect(40, 650, 120, 20), pad, text)).toBeNull()
  })
})

describe('Open ↗', () => {
  it('opens a web page in Safari’s sheet in the iPhone app', async () => {
    env.native = true
    openNoteLink(PAGE)
    await new Promise(r => setTimeout(r, 0))
    expect(env.opened).toEqual([PAGE])
  })

  it('opens a web page in a new tab in a browser', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    openNoteLink(PAGE)
    expect(open).toHaveBeenCalledWith(PAGE, '_blank', 'noopener')
  })

  it('hands an email address to the mail app, never to Safari’s sheet, which cannot show one', async () => {
    for (const native of [true, false]) {
      env.native = native
      const location = { href: 'capacitor://drafter/' }
      vi.stubGlobal('window', { location, open: vi.fn() })
      openNoteLink('mailto:dave@example.com')
      expect(location.href).toBe('mailto:dave@example.com')
    }
    await new Promise(r => setTimeout(r, 0))
    expect(env.opened).toEqual([])
  })
})
