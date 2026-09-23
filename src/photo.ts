// A garment's photo, made ready on the device before it is saved: one decode of
// whatever was picked (the camera's 12MP JPEG, a HEIC the browser can read, a
// screenshot), then two JPEGs drawn from it — the 1200px photo the piece sheet
// shows and the 360px thumbnail every row, grid and card uses, because a closet
// of 60 full-size photos would decode about 400MB of bitmaps in a WKWebView.
// A task's or a note's picture goes through the same decode (preparePicture).
// The maths is pure and tested; the DOM part is thin.

/** The photo cannot be decoded here: a HEIC in desktop Chrome, or a file that is no image at all. */
export class PhotoUnreadable extends Error {
  constructor() {
    super('That photo can’t be read here — try a JPEG or PNG')
    this.name = 'PhotoUnreadable'
  }
}

/** The piece sheet's photo, longest edge. */
export const PHOTO_EDGE = 1200
/** The thumbnail every row, grid and card draws, longest edge. */
export const THUMB_EDGE = 360

/** Fit inside maxEdge on the longest side, never upscaled, rounded and never under 1px. */
export function fitWithin(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h, 1))
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

/**
 * The average of RGBA pixels as #rrggbb. Mostly transparent pixels are
 * skipped, and so are near-white ones (every channel 245 or more) unless
 * nothing else is left, so a garment photographed on white reads as its own
 * colour. Nothing opaque at all reads as white.
 */
export function averageHex(rgba: Uint8ClampedArray): string {
  const colour = [0, 0, 0, 0]
  const white = [0, 0, 0, 0]
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue
    const [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]]
    const into = r >= 245 && g >= 245 && b >= 245 ? white : colour
    into[0] += r
    into[1] += g
    into[2] += b
    into[3]++
  }
  const [r, g, b, n] = colour[3] > 0 ? colour : white
  if (n === 0) return '#ffffff'
  const hex = (sum: number) => Math.round(sum / n).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** One decode, through an <img> so the browser turns the photo the way the camera held it (EXIF). */
async function decode(file: Blob): Promise<{ img: HTMLImageElement; release(): void }> {
  const url = URL.createObjectURL(file)
  const img = new Image()
  const release = () => {
    URL.revokeObjectURL(url)
    img.removeAttribute('src')
  }
  img.src = url
  try {
    await img.decode()
  } catch {
    release()
    throw new PhotoUnreadable()
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    release()
    throw new PhotoUnreadable()
  }
  return { img, release }
}

/** `source` drawn inside maxEdge on a canvas filled white first: a JPEG has no transparency to fall back on. */
function drawn(source: CanvasImageSource, w: number, h: number, maxEdge: number): HTMLCanvasElement {
  const size = fitWithin(w, h, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = size.w
  canvas.height = size.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PhotoUnreadable()
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, size.w, size.h)
  ctx.drawImage(source, 0, 0, size.w, size.h)
  return canvas
}

function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new PhotoUnreadable())), 'image/jpeg', quality))
}

/** The thumbnail's centre 40%, averaged: the garment, not the bed or floor it lies on. */
function centreColour(canvas: HTMLCanvasElement): string | undefined {
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const [x, y] = [Math.floor(canvas.width * 0.3), Math.floor(canvas.height * 0.3)]
  const [w, h] = [Math.max(1, Math.round(canvas.width * 0.4)), Math.max(1, Math.round(canvas.height * 0.4))]
  try {
    return averageHex(ctx.getImageData(x, y, w, h).data)
  } catch {
    return undefined
  }
}

/**
 * Whether the photo can be kept byte for byte as the piece's photo: the
 * cut-out sheet's JPEG (the garment on white, written by a canvas, so with no
 * EXIF) already at the photo's size or under. Encoding it again would only
 * lose detail; anything else is drawn afresh.
 */
export function keepsAsIs(type: string, width: number, height: number, cutout: boolean): boolean {
  return cutout && type === 'image/jpeg' && Math.max(width, height) <= PHOTO_EDGE
}

// ---- a task's or a note's picture
//
// Pictures on a task or in a note were saved as they were picked: the
// camera's 12MP photo, 2–5 MB, kept on the device, uploaded whole, and
// decoded whole (48 MB of bitmap) by every device that drew it, even as a
// 64px square in the task editor. They go through the same one decode as a
// garment's now, at a size of their own.

/**
 * A task's or a note's picture, longest edge: more than a garment's 1200,
 * as a photographed receipt, label or page has to stay legible when zoomed,
 * and still a sixth of a 12MP photo's pixels.
 */
export const PICTURE_EDGE = 1600

/** Kept as they are without a decode: a redraw would still a GIF and flatten an SVG. */
const KEPT_WHOLE = new Set(['image/gif', 'image/svg+xml'])
/** Types every browser shows: one within the edge needs no redraw. A HEIC is not one. */
const SHOWN_EVERYWHERE = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * Whether a picture is kept byte for byte: a GIF or an SVG, or a JPEG, PNG or
 * WebP already within PICTURE_EDGE — a screenshot, an image saved from a page
 * — where drawing it again would only lose detail (and a PNG its
 * transparency). Anything else is drawn afresh: the camera's full-size photo,
 * and a HEIC, which the other member's browser might not show at all.
 */
export function keepsPicture(type: string, width: number, height: number): boolean {
  return KEPT_WHOLE.has(type) || (SHOWN_EVERYWHERE.has(type) && Math.max(width, height) <= PICTURE_EDGE)
}

/**
 * A task's or a note's picture made ready to save: the picture to keep —
 * the file itself when keepsPicture, else drawn at PICTURE_EDGE as a JPEG
 * (0.82) on white — and a THUMB_EDGE thumbnail (JPEG 0.72) for the task
 * editor's squares, null when the picture is no bigger than one or is kept
 * whole. One decode, through an <img>, so a photo keeps the way the camera
 * held it. Throws PhotoUnreadable when this browser cannot decode the file (a
 * HEIC in desktop Chrome); the caller then keeps the file as it came.
 */
export async function preparePicture(file: Blob): Promise<{ picture: Blob; thumb: Blob | null }> {
  if (KEPT_WHOLE.has(file.type)) return { picture: file, thumb: null }
  const { img, release } = await decode(file)
  try {
    const [w, h] = [img.naturalWidth, img.naturalHeight]
    const big = keepsPicture(file.type, w, h) ? null : drawn(img, w, h, PICTURE_EDGE)
    const small = Math.max(w, h) > THUMB_EDGE ? drawn(img, w, h, THUMB_EDGE) : null
    const [picture, thumb] = await Promise.all([big ? jpeg(big, 0.82) : file, small ? jpeg(small, 0.72) : null])
    // let go of the pixels now, not whenever the canvases are collected
    if (big) big.width = big.height = 0
    if (small) small.width = small.height = 0
    return { picture, thumb }
  } finally {
    release()
  }
}

/**
 * Decode once, then draw the 1200px photo (JPEG 0.82) and the 360px thumbnail
 * (JPEG 0.72), each on white, and sample the thumbnail's centre for the piece's
 * colour. Only the two destination canvases ever hold pixels (1.9MP at most);
 * the decoded source goes when the <img> does. Throws PhotoUnreadable when the
 * browser cannot decode the file.
 *
 * The cut-out step (`cutout`): the file is what the cut-out sheet's Looks good
 * handed over (src/components/CutoutSheet.tsx). A cut-out of 1200px or less is
 * kept as the photo itself, and only the thumbnail and colour are made.
 */
export async function prepareGarmentPhoto(file: Blob, opts: { cutout?: boolean } = {}): Promise<{ photo: Blob; thumb: Blob; color?: string }> {
  const { img, release } = await decode(file)
  try {
    const [w, h] = [img.naturalWidth, img.naturalHeight]
    const big = keepsAsIs(file.type, w, h, opts.cutout === true) ? null : drawn(img, w, h, PHOTO_EDGE)
    const small = drawn(img, w, h, THUMB_EDGE)
    const color = centreColour(small)
    const [photo, thumb] = await Promise.all([big ? jpeg(big, 0.82) : file, jpeg(small, 0.72)])
    // let go of the pixels now, not whenever the canvases are collected
    if (big) big.width = big.height = 0
    small.width = small.height = 0
    return { photo, thumb, color }
  } finally {
    release()
  }
}
