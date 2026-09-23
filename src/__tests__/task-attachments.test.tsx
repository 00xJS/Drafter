import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// Opening a file on a task did nothing in the iPhone app: the tap clicked a
// blob: download link, WKWebView has no downloads, and Capacitor passes the
// link on to Safari, which cannot open it. The file now goes through saveFile
// (the share sheet in the app, a download in a browser), and whatever opening
// it has to say sits under that file's own row, not at the foot of the editor.

vi.mock('../media', () => ({
  // nothing on this device, and no server to fetch it from
  mediaURL: async () => null,
  saveMedia: async () => 'm-new',
}))

import { AttachmentList, Attachments, NOT_OFFLINE, openAttachment, type Opening } from '../components/taskeditor/Attachments'
import type { Attachment } from '../types'
import { propsOf, settled, textOf } from './rendered'

const QUOTE: Attachment = { id: 'm1', name: 'quote.pdf', type: 'application/pdf', size: 120_000 }
const PHOTO: Attachment = { id: 'm2', name: 'porch.heic', type: 'image/heic', size: 2_400_000 }
const pdf = () => new Blob(['%PDF-1.7'], { type: 'application/pdf' })

describe('opening a file on a task', () => {
  it('hands the file itself to saveFile, under the name it was attached with', async () => {
    const file = pdf()
    const save = vi.fn(async (_name: string, _blob: Blob) => {})
    await expect(openAttachment(QUOTE, { load: async () => file, save })).resolves.toBeNull()
    expect(save).toHaveBeenCalledWith('quote.pdf', file)
  })

  it('says so when this device has not got the file and cannot fetch it', async () => {
    const save = vi.fn(async () => {})
    await expect(openAttachment(QUOTE, { load: async () => null, save })).resolves.toEqual({ id: 'm1', phase: 'note', text: NOT_OFFLINE })
    // a fetch that failed outright reads the same, rather than escaping the tap
    await expect(
      openAttachment(QUOTE, {
        load: async () => {
          throw new TypeError('Load failed')
        },
        save,
      }),
    ).resolves.toEqual({ id: 'm1', phase: 'note', text: NOT_OFFLINE })
    expect(save).not.toHaveBeenCalled()
  })

  it('offers Save when the share sheet refused a tap the download outlasted, keeping the file it fetched', async () => {
    const file = pdf()
    const outcome = await openAttachment(QUOTE, {
      load: async () => file,
      save: async () => {
        throw new DOMException('The request is not allowed by the user agent', 'NotAllowedError')
      },
    })
    expect(outcome).toEqual({ id: 'm1', phase: 'ready', blob: file })
  })

  it('says any other failure in its own words', async () => {
    const outcome = await openAttachment(QUOTE, {
      load: async () => pdf(),
      save: async () => {
        throw new Error('This phone cannot hand files to other apps.')
      },
    })
    expect(outcome).toEqual({ id: 'm1', phase: 'note', text: 'This phone cannot hand files to other apps.' })
  })
})

const list = (opening: Opening | null) =>
  renderToStaticMarkup(<AttachmentList attachments={[QUOTE, PHOTO]} opening={opening} onOpen={() => {}} onSave={() => {}} onRemove={() => {}} />)

/** Each list row in order: a file by its name, or `after` for what opening one said. */
const rows = (html: string) =>
  html
    .split('<li')
    .slice(1)
    .map(li => (li.includes('class="attachment"') ? (/📎 ([^ <]+)/.exec(li)?.[1] ?? '?') : 'after'))

describe('what opening a file says, under its own row', () => {
  it('puts "not available offline" directly under the file that was tapped', () => {
    const html = list({ id: 'm1', phase: 'note', text: NOT_OFFLINE })
    expect(rows(html)).toEqual(['quote.pdf', 'after', 'porch.heic'])
    expect(html).toContain('role="alert"')
    expect(html.match(/not available offline/g)).toHaveLength(1)
  })

  it('puts the Save button under the file it will save, named for it', () => {
    const html = list({ id: 'm2', phase: 'ready', blob: pdf() })
    expect(rows(html)).toEqual(['quote.pdf', 'porch.heic', 'after'])
    expect(html).toContain('aria-label="Save porch.heic"')
  })

  it('says Fetching… in the one row that is fetching, and nothing under any', () => {
    const html = list({ id: 'm1', phase: 'fetching' })
    expect(rows(html)).toEqual(['quote.pdf', 'porch.heic'])
    expect(html.match(/Fetching…/g)).toHaveLength(1)
    expect(html).toContain('2.4 MB')
    expect(html).not.toContain('120 KB')
  })

  it('shows sizes and nothing else when no file is opening', () => {
    const html = list(null)
    expect(rows(html)).toEqual(['quote.pdf', 'porch.heic'])
    expect(html).toContain('120 KB')
    expect(html).not.toContain('role="alert"')
  })
})

describe('a tap on a file', () => {
  it('marks that file as fetching at once', () => {
    const tree = settled(Attachments, { attachments: [QUOTE, PHOTO], set: () => {} }, t => propsOf(t, AttachmentList).onOpen(PHOTO))
    expect(propsOf(tree, AttachmentList).opening).toEqual({ id: 'm2', phase: 'fetching' })
    expect(textOf(tree)).toContain('Files')
  })
})
