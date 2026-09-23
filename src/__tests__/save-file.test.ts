import { afterEach, describe, expect, it, vi } from 'vitest'

// Settings → Export a file and Admin's Save the readable copy both did
// nothing in the iPhone app: they clicked a download link, WKWebView has no
// downloads, and Capacitor passed the blob: link on to Safari, which cannot
// open it. Inside the app the file now goes to the share sheet, whose "Save
// to Files" is the download; a browser still gets the plain one.

const env = vi.hoisted(() => ({ native: true }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') },
  registerPlugin: () => ({}),
}))

import { saveFile } from '../native'

const json = () => new Blob(['{"items":[]}'], { type: 'application/json' })

afterEach(() => {
  env.native = true
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saving a file', () => {
  it('hands it to the share sheet inside the iPhone app, named and typed', async () => {
    const share = vi.fn(async (_data: { files: File[] }) => {})
    vi.stubGlobal('navigator', { share })
    await saveFile('drafter-2026-09-22.json', json())
    expect(share).toHaveBeenCalledTimes(1)
    const files = share.mock.calls[0][0].files
    expect(files.map(f => [f.name, f.type])).toEqual([['drafter-2026-09-22.json', 'application/json']])
    await expect(files[0].text()).resolves.toBe('{"items":[]}')
  })

  it('takes closing the sheet as nothing, and any other failure as one', async () => {
    vi.stubGlobal('navigator', {
      share: async () => {
        throw new DOMException('Share canceled', 'AbortError')
      },
    })
    await expect(saveFile('a.json', json())).resolves.toBeUndefined()
    vi.stubGlobal('navigator', {
      share: async () => {
        throw new DOMException('Not allowed', 'NotAllowedError')
      },
    })
    await expect(saveFile('a.json', json())).rejects.toThrow('Not allowed')
    // a shell with no share sheet at all says so, rather than failing in silence
    vi.stubGlobal('navigator', {})
    await expect(saveFile('a.json', json())).rejects.toThrow(/cannot hand files/)
  })

  it('downloads it in a browser, and never opens a share sheet there', async () => {
    env.native = false
    const share = vi.fn()
    const link = { href: '', download: '', click: vi.fn() }
    vi.stubGlobal('navigator', { share })
    vi.stubGlobal('document', { createElement: () => link })
    vi.stubGlobal('window', { setTimeout: vi.fn() })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:drafter/1')
    await saveFile('drafter-2026-09-22.json', json())
    expect(link).toMatchObject({ href: 'blob:drafter/1', download: 'drafter-2026-09-22.json' })
    expect(link.click).toHaveBeenCalledTimes(1)
    expect(share).not.toHaveBeenCalled()
  })
})
