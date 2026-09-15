import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CutoutPreview, CutoutSheet, type CutoutPreviewProps, type PreviewState } from '../components/CutoutSheet'
import { CutoutLater, cutoutLaterLabel, keptOffline, UNREADABLE, wasKeptOffline } from '../components/wardrobe/CutoutLater'
import { CUTOUT_TOTAL_BYTES } from '../cutoutassets'

// "Check the cut-out", in every state it can be in. The copy is pinned: each
// line tells the owner what happened and what the buttons will do.

const noop = () => {}
const base: CutoutPreviewProps = {
  photoUrl: 'blob:photo',
  cutoutUrl: 'blob:cutout',
  state: 'done',
  canPick: true,
  view: 'cutout',
  onView: noop,
  onPick: noop,
  onAccept: noop,
  onUseOriginal: noop,
  onRetake: noop,
  onRetry: noop,
}
const render = (over: Partial<CutoutPreviewProps> = {}) => renderToStaticMarkup(<CutoutPreview {...base} {...over} />)

/** The visible text, entities undone and whitespace squashed. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

/** Each button's opening tag and its label. */
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({ attrs: m[1], label: m[2].replace(/<[^>]+>/g, '').trim() }))
const button = (html: string, label: string) => buttons(html).find(b => b.label === label)
const classOf = (html: string, label: string) => /class="([^"]*)"/.exec(button(html, label)?.attrs ?? '')?.[1]

const MB = 1_048_576

describe('while the photo is read', () => {
  it('dims the photo and says so', () => {
    const html = render({ state: 'preparing', cutoutUrl: undefined })
    expect(html).toContain('data-state="preparing"')
    expect(text(html)).toContain('Getting the photo ready…')
    expect(button(html, 'Looks good')).toBeUndefined()
  })
})

describe('the first download', () => {
  const html = render({ state: 'downloading', cutoutUrl: undefined, progress: { loaded: Math.round(7.2 * MB), total: CUTOUT_TOTAL_BYTES } })

  it('shows a determinate bar', () => {
    expect(html).toMatch(/<div class="cutout-bar" role="progressbar"[^>]*aria-valuemin="0" aria-valuemax="100" aria-valuenow="41">/)
  })

  it('counts it in megabytes, and says it is once and on this device', () => {
    expect(text(html)).toContain('Getting the cut-out ready · 7.2 of 17.5 MB')
    expect(text(html)).toContain('Only the first time. The cut-out is made on this device.')
  })

  it('offers Retake and Use original, and nothing to accept yet', () => {
    expect(button(html, 'Retake')).toBeTruthy()
    expect(classOf(html, 'Use original')).toBe('btn')
    expect(button(html, 'Looks good')).toBeUndefined()
  })
})

describe('while cutting out', () => {
  it('says so where a screen reader hears it, over a spinner', () => {
    const html = render({ state: 'cutting', cutoutUrl: undefined })
    expect(html).toMatch(/<p class="cutout-status" aria-live="polite">Cutting out…<\/p>/)
    expect(html).toContain('<span class="cutout-spinner" aria-hidden="true"></span>')
  })
})

describe('the cut-out', () => {
  const html = render()

  it('offers Retake, Use original and Looks good, in that order of weight', () => {
    expect(buttons(html).map(b => b.label).filter(l => ['Retake', 'Use original', 'Looks good'].includes(l))).toEqual(['Retake', 'Use original', 'Looks good'])
    expect(classOf(html, 'Retake')).toBe('btn subtle')
    expect(classOf(html, 'Use original')).toBe('btn')
    expect(classOf(html, 'Looks good')).toBe('btn primary')
  })

  it('names both images', () => {
    expect(html).toContain('alt="Your photo"')
    expect(html).toContain('alt="The garment on white"')
    expect(html).toContain('<div class="cutout-stage cutout-white"><img src="blob:cutout"')
  })

  it('has the phone’s Cut-out · Photo switch, with the cut-out showing first', () => {
    expect(html).toMatch(/<div class="segmented cutout-seg" role="group" aria-label="Show">/)
    expect(button(html, 'Cut-out')?.attrs).toContain('class="seg on" aria-pressed="true"')
    expect(button(html, 'Photo')?.attrs).toContain('class="seg" aria-pressed="false"')
    expect(html).toContain('<div class="cutout-panes two" data-view="cutout">')
    expect(render({ view: 'photo' })).toContain('<div class="cutout-panes two" data-view="photo">')
  })

  it('makes the photo a button to pick the garment, where the web engine can run', () => {
    expect(html).toContain('aria-label="Tap the garment to pick it"')
    expect(text(html)).toContain('Picked the wrong thing? Tap the garment in the photo.')
    const cannot = render({ canPick: false })
    expect(cannot).not.toContain('Tap the garment to pick it')
    expect(text(cannot)).not.toContain('Picked the wrong thing?')
  })

  it('says when it may have missed the garment', () => {
    const note = 'This may have missed the garment. Tap it in the photo, or use the original.'
    expect(text(render({ doubtful: true }))).toContain(note)
    expect(text(html)).not.toContain(note)
  })

  it('offers + Add another beside the hint, after which a tap keeps one more thing', () => {
    const offered = render({ onAdding: noop })
    expect(button(offered, '+ Add another')?.attrs).toBe(' type="button" class="toggle" aria-pressed="false"')
    const adding = render({ onAdding: noop, adding: true })
    expect(button(adding, '+ Add another')?.attrs).toBe(' type="button" class="toggle on" aria-pressed="true"')
    expect(text(adding)).toContain('Now tap the other thing to keep, in the photo.')
    expect(adding).toContain('aria-label="Tap another thing to keep it too"')
    // nothing to add to where the photo cannot be tapped, or where no one listens
    expect(button(render({ onAdding: noop, canPick: false }), '+ Add another')).toBeUndefined()
    expect(button(html, '+ Add another')).toBeUndefined()
  })
})

describe('no cut-out', () => {
  it('asks for a tap when no garment was found, and makes the original the main button', () => {
    const html = render({ state: 'unavailable', cutoutUrl: undefined, reason: 'no-garment' })
    expect(text(html)).toContain('Couldn’t find a garment here. Tap it in the photo, or use the original.')
    expect(classOf(html, 'Use original')).toBe('btn primary')
    expect(button(html, 'Retake')).toBeTruthy()
    expect(html).toContain('aria-label="Tap the garment to pick it"')
    expect(button(html, 'Looks good')).toBeUndefined()
  })

  it('explains the one-time download when offline', () => {
    const html = render({ state: 'unavailable', cutoutUrl: undefined, reason: 'offline' })
    expect(text(html)).toContain('Cutting out needs a one-time download (17.5 MB), and you’re offline. Use the photo as it is for now.')
    expect(classOf(html, 'Use original')).toBe('btn primary')
    expect(html).not.toContain('Tap the garment to pick it')
    expect(button(html, 'Cut out now')).toBeUndefined()
  })

  it('offers Cut out now once the device is back online', () => {
    const html = render({ state: 'unavailable', cutoutUrl: undefined, reason: 'offline', backOnline: true })
    expect(text(html)).toContain('You’re back online, so the cut-out can be made now.')
    expect(classOf(html, 'Cut out now')).toBe('btn primary')
    expect(classOf(html, 'Use original')).toBe('btn')
    // a failure is not an offline try: Try again, as ever
    expect(button(render({ state: 'unavailable', cutoutUrl: undefined, reason: 'failed', backOnline: true }), 'Cut out now')).toBeUndefined()
  })

  it('says when this browser cannot do it', () => {
    const html = render({ state: 'unavailable', cutoutUrl: undefined, reason: 'unsupported' })
    expect(text(html)).toContain('This browser can’t cut out photos. Use the photo as it is.')
    expect(button(html, 'Try again')).toBeUndefined()
  })

  it('offers to try again when it failed', () => {
    const html = render({ state: 'unavailable', cutoutUrl: undefined, reason: 'failed' })
    expect(text(html)).toContain('The cut-out didn’t work this time.')
    expect(classOf(html, 'Try again')).toBe('btn')
    expect(classOf(html, 'Use original')).toBe('btn primary')
  })
})

describe('every state', () => {
  const states: Partial<CutoutPreviewProps>[] = [
    { state: 'preparing' },
    { state: 'downloading', progress: { loaded: 1, total: 2 } },
    { state: 'cutting' },
    { state: 'done', doubtful: true },
    { state: 'done', onAdding: noop, adding: true },
    { state: 'unavailable', reason: 'offline', backOnline: true },
    ...(['no-garment', 'offline', 'unsupported', 'failed'] as const).map(reason => ({ state: 'unavailable' as PreviewState, reason })),
  ]

  it('gives every button type="button", so none can submit anything', () => {
    for (const over of states) {
      const found = buttons(render(over))
      expect(found.length, over.state).toBeGreaterThanOrEqual(2)
      for (const b of found) expect(b.attrs, `${over.state} ${b.label}`).toMatch(/^ type="button"/)
    }
  })
})

describe('Cut out background, from the piece sheet', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

  it('says what it will do, and is not there where it cannot run', () => {
    expect(cutoutLaterLabel(true, 'native', false)).toBe('Cut out background')
    expect(cutoutLaterLabel(true, 'web', false)).toBe('Cut out background')
    // offline before the one-time download, and then back online
    expect(cutoutLaterLabel(true, 'offline', true)).toBeNull()
    expect(cutoutLaterLabel(true, 'web', true)).toBe('Cut out now')
    expect(cutoutLaterLabel(true, 'native', true)).toBe('Cut out now')
    // a cut-out already, a photo not read yet, a browser that cannot, a question not answered
    expect(cutoutLaterLabel(false, 'web', false)).toBeNull()
    expect(cutoutLaterLabel(null, 'web', false)).toBeNull()
    expect(cutoutLaterLabel(true, 'unsupported', false)).toBeNull()
    expect(cutoutLaterLabel(true, null, false)).toBeNull()
    // the back photo's own button says which photo it cuts out
    expect(cutoutLaterLabel(true, 'web', false, 'back')).toBe('Cut out the back')
    expect(cutoutLaterLabel(true, 'native', true, 'back')).toBe('Cut out the back now')
    expect(cutoutLaterLabel(false, 'web', false, 'back')).toBeNull()
    expect(cutoutLaterLabel(true, 'offline', true, 'back')).toBeNull()
  })

  it('is one line in the piece sheet for each photo, and replaces it as Replace photo and Replace back photo do', () => {
    const sheet = read('../components/wardrobe/GarmentSheet.tsx')
    expect(sheet.match(/<CutoutLater /g)).toHaveLength(2)
    expect(sheet).toContain('<CutoutLater garment={g} disabled={photoBusy} onCutout={file => void replace(file, true)} onError={setPhotoError} />')
    expect(sheet).toContain(`<CutoutLater garment={g} side="back" disabled={photoBusy} onCutout={file => void replace(file, true, false, 'back')} onError={setPhotoError} />`)
    // it reads the photo of the side it is for
    expect(read('../components/wardrobe/CutoutLater.tsx')).toContain("const [photoId, thumbId] = side === 'back' ? [garment.backPhotoId, garment.backThumbId] : [garment.photoId, garment.thumbId]")
  })

  it('says so in the piece sheet when the saved photo cannot be read, rather than doing nothing', () => {
    const later = read('../components/wardrobe/CutoutLater.tsx')
    expect(later).toMatch(/const open = async \(\) => \{[\s\S]*?try \{[\s\S]*?\} catch \{\s*onError\?\.\(UNREADABLE\)/)
    // a fetch that answers 404 is no photo either
    expect(later).toContain('return response.ok ? response.blob() : null')
    expect(UNREADABLE).toBe('That photo could not be read on this device — try again online')
  })

  it('remembers, on this device, a photo kept as it was for being offline, so its sheet says Cut out now online', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
    try {
      expect(wasKeptOffline('p1')).toBe(false)
      keptOffline('p1')
      keptOffline('p2')
      keptOffline('p1')
      expect(JSON.parse(store.get('drafter:uncut-offline')!)).toEqual(['p2', 'p1'])
      expect(wasKeptOffline('p1')).toBe(true)
      expect(wasKeptOffline(undefined)).toBe(false)
      expect(cutoutLaterLabel(true, 'web', wasKeptOffline('p1'))).toBe('Cut out now')
      // still nothing while no cut-out can be made
      expect(cutoutLaterLabel(true, 'offline', wasKeptOffline('p1'))).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
    // storage blocked: nothing remembered, and nothing thrown
    const blocked = () => {
      throw new Error('blocked')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    try {
      expect(() => keptOffline('p1')).not.toThrow()
      expect(wasKeptOffline('p1')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('learns it from Use original offline, in Add clothing and in Replace photo, and forgets it once cut out or turned down online', () => {
    expect(read('../components/CutoutSheet.tsx')).toContain("offline: result?.reason === 'offline' && !online")
    const sheet = read('../components/wardrobe/GarmentSheet.tsx')
    // Add clothing's front and back, and a photo for either side of a piece
    expect(sheet).toContain('if (front && picked?.offline) keptOffline(front.photoId)')
    expect(sheet).toContain('if (backIds && backPicked?.offline) keptOffline(backIds.photoId)')
    expect(sheet).toContain('if (offline) keptOffline(ids.photoId)')
    expect(read('../components/wardrobe/CutoutLater.tsx')).toContain('if (info.cutout || !info.offline) forgetOffline(id)')
  })

  it('opens Check the cut-out over the piece sheet, not inside it, leaving the sheet as it was', () => {
    const sheet = read('../components/wardrobe/GarmentSheet.tsx')
    // Add clothing's front and back, and the piece sheet's either side
    expect(sheet.match(/createPortal\(/g)).toHaveLength(3)
    // no fragment round either sheet's Modal, so its lines keep their place
    expect(sheet).not.toMatch(/<>\s*<Modal/)
    expect(sheet.match(/^ {4}<Modal onClose=\{close\} className="modal narrow garment-sheet">$/gm)).toHaveLength(2)
  })

  it('shows nothing until it has read the photo, so a server render has no button', () => {
    const T = '2026-09-14T09:00:00.000Z'
    const html = renderToStaticMarkup(
      <CutoutLater garment={{ kind: 'garment', id: 'g1', name: 'Tee', type: 'top', photoId: 'p1', thumbId: 't1', createdAt: T, updatedAt: T }} onCutout={noop} />,
    )
    expect(html).toBe('')
  })

  it('keeps to the wardrobe’s rules: no project, no haptics, and a sheet of its own over the piece’s', () => {
    const later = read('../components/wardrobe/CutoutLater.tsx')
    expect(later).not.toMatch(/project/i)
    expect(later).not.toMatch(/haptic\(/)
    expect(later).toContain('createPortal(')
  })
})

describe('the sheet', () => {
  it('renders without a document, as a named dialog', () => {
    const html = renderToStaticMarkup(<CutoutSheet photo={new Blob([new Uint8Array(4)], { type: 'image/jpeg' })} onDone={noop} onCancel={noop} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Check the cut-out')
    expect(html).toContain('<input type="file" accept="image/*" hidden=""/>')
    expect(html).not.toContain('capture=')
  })
})
