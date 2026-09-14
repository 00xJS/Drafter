/*
 * The garment cut-out's image maths. No DOM (node has no ImageData), so every
 * step is tested on plain buffers in src/__tests__/cutout-math.test.ts.
 *
 * Both engines end here. Apple's subject lifting on the iPhone hands over the
 * garment on transparency; the web engine (src/cutoutweb.ts) a confidence
 * mask, which refineMask makes solid. finishOnWhite is then the one finish for
 * both: the garment on pure white, cropped with the same padding on every
 * side, at most 1200 px on its long edge.
 *
 * Buffers are row-major. An Rgba has straight (not premultiplied) alpha, which
 * is what a canvas's getImageData gives back.
 */

/** Every number the cut-out is tuned by. */
export const CUTOUT = {
  // what both engines look at, the web engine's mask, and the finished JPEG
  workEdge: 1600,
  maskEdge: 1024,
  outEdge: 1200,
  jpegQuality: 0.88,
  // refineMask: the confident core, what survives beside it, the holes it fills, the rim
  coreThreshold: 0.5,
  keepShare: 0.1,
  holeShare: 0.002,
  outerPx: 6,
  innerPx: 3,
  edgeLo: 0.3,
  edgeHi: 0.7,
  // the crop: which pixels count as garment, and the padding round them
  boxAlphaMin: 26,
  padRatio: 0.08,
  padMin: 12,
  // judging a mask: too little of the photo, nearly all of it, or pressed against its sides
  tinyCoverage: 0.02,
  wholeCoverage: 0.9,
  frameEdges: 3,
  nearEdgePx: 2,
  nearEdgeShare: 0.01,
  smallCropPx: 300,
  // where the web engine looks without a tap: the middle, then a little above and below it
  seeds: [
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.36 },
    { x: 0.5, y: 0.64 },
  ],
} as const

export interface Rgba {
  width: number
  height: number
  data: Uint8ClampedArray<ArrayBuffer>
}

/** One value a pixel, usually 0..1: a confidence mask, or an alpha on its way to bytes. */
export interface Plane {
  width: number
  height: number
  data: Float32Array
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Normalised 0..1 across the upright photo. */
export interface Point {
  x: number
  y: number
}

export interface MaskStats {
  /** The share of pixels at alpha 128 or more. */
  coverage: number
  /** The tight box of every pixel at CUTOUT.boxAlphaMin or more; null when there is none. */
  box: Box | null
  /** How many sides of the image the box comes within max(2 px, 1%) of. */
  edgesTouched: number
}

export type MaskVerdict = 'ok' | 'empty' | 'tiny' | 'whole-photo' | 'frame'

// ---- sizes -----------------------------------------------------------------

/** Fit width × height inside a square of `edge`, keeping the shape. Never upscales, never below 1 px. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const long = Math.max(width, height)
  const scale = long > edge ? edge / long : 1
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** For each output cell along one axis: the first source cell it covers, and how much of each it takes (summing to 1). */
function areaSpans(from: number, to: number): { start: number; weights: Float64Array }[] {
  const spans = []
  for (let i = 0; i < to; i++) {
    const lo = (i * from) / to
    const hi = ((i + 1) * from) / to
    const start = Math.floor(lo)
    const weights = new Float64Array(Math.min(from, Math.ceil(hi)) - start)
    for (let k = 0; k < weights.length; k++) weights[k] = ((Math.min(hi, start + k + 1) - Math.max(lo, start + k)) * to) / from
    spans.push({ start, weights })
  }
  return spans
}

/** One source row, area-averaged across to the output width, into `line` (four floats a pixel). */
function resampleRow(src: Rgba, y: number, xs: ReturnType<typeof areaSpans>, line: Float64Array): void {
  const row = y * src.width * 4
  for (let x = 0; x < xs.length; x++) {
    const { start, weights } = xs[x]
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let k = 0; k < weights.length; k++) {
      const at = row + (start + k) * 4
      const w = weights[k]
      r += src.data[at] * w
      g += src.data[at + 1] * w
      b += src.data[at + 2] * w
      a += src.data[at + 3] * w
    }
    line[x * 4] = r
    line[x * 4 + 1] = g
    line[x * 4 + 2] = b
    line[x * 4 + 3] = a
  }
}

/**
 * Resize by exact area averaging: each output pixel is the mean of the source
 * area it covers, partial pixels weighted by how much of them it covers. Pure
 * white stays exactly 255, and the same input always gives the same bytes —
 * unlike a canvas, whose downscale differs between browsers.
 */
export function resizeArea(src: Rgba, width: number, height: number): Rgba {
  const out = new Uint8ClampedArray(width * height * 4)
  if (width === src.width && height === src.height) {
    out.set(src.data)
    return { width, height, data: out }
  }
  const xs = areaSpans(src.width, width)
  const ys = areaSpans(src.height, height)
  const line = new Float64Array(width * 4)
  const sum = new Float64Array(width * 4)
  for (let y = 0; y < height; y++) {
    sum.fill(0)
    const { start, weights } = ys[y]
    for (let k = 0; k < weights.length; k++) {
      resampleRow(src, start + k, xs, line)
      const w = weights[k]
      for (let i = 0; i < line.length; i++) sum[i] += line[i] * w
    }
    const row = y * width * 4
    for (let i = 0; i < sum.length; i++) out[row + i] = Math.round(sum[i])
  }
  return { width, height, data: out }
}

/** Bilinear resize of a plane, pixel centres aligned the way a canvas draws. Values stay inside the input's range. */
export function resizePlaneBilinear(src: Plane, width: number, height: number): Plane {
  const out = new Float32Array(width * height)
  const x0 = new Int32Array(width)
  const x1 = new Int32Array(width)
  const fx = new Float64Array(width)
  for (let x = 0; x < width; x++) {
    const u = Math.min(src.width - 1, Math.max(0, ((x + 0.5) * src.width) / width - 0.5))
    x0[x] = Math.floor(u)
    x1[x] = Math.min(src.width - 1, x0[x] + 1)
    fx[x] = u - x0[x]
  }
  for (let y = 0; y < height; y++) {
    const v = Math.min(src.height - 1, Math.max(0, ((y + 0.5) * src.height) / height - 0.5))
    const top = Math.floor(v) * src.width
    const bottom = Math.min(src.height - 1, Math.floor(v) + 1) * src.width
    const fy = v - Math.floor(v)
    for (let x = 0; x < width; x++) {
      const a = src.data[top + x0[x]] + (src.data[top + x1[x]] - src.data[top + x0[x]]) * fx[x]
      const b = src.data[bottom + x0[x]] + (src.data[bottom + x1[x]] - src.data[bottom + x0[x]]) * fx[x]
      out[y * width + x] = a + (b - a) * fy
    }
  }
  return { width, height, data: out }
}

// ---- alpha -----------------------------------------------------------------

/** The alpha channel of an image. */
export function alphaOf(src: Rgba): Uint8Array {
  const alpha = new Uint8Array(src.width * src.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = src.data[i * 4 + 3]
  return alpha
}

/** A 0..1 plane as alpha bytes. */
export function planeToAlpha(p: Plane): Uint8Array {
  const alpha = new Uint8Array(p.width * p.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(Math.min(1, Math.max(0, p.data[i])) * 255)
  return alpha
}

/** 0 at or below `lo`, 1 at or above `hi`, and a smooth S between. */
export function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/** The pixel a normalised point lands on. */
function pixelAt(p: { width: number; height: number }, at: Point): number {
  const x = Math.min(p.width - 1, Math.max(0, Math.floor(at.x * p.width)))
  const y = Math.min(p.height - 1, Math.max(0, Math.floor(at.y * p.height)))
  return y * p.width + x
}

/** The mean of a plane within `r` pixels of a point. */
function meanAround(p: Plane, at: Point, r: number): number {
  const i = pixelAt(p, at)
  const cx = i % p.width
  const cy = (i - cx) / p.width
  let sum = 0
  let count = 0
  for (let y = Math.max(0, cy - r); y <= Math.min(p.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(p.width - 1, cx + r); x++) {
      sum += p.data[y * p.width + x]
      count++
    }
  }
  return sum / count
}

/**
 * Which confidence mask is the garment's: the one that is higher where the
 * seed is (a 5 × 5 mean, so one odd pixel cannot decide). MagicTouch's card
 * says its two channels are [background, foreground]; this does not rely on
 * the order.
 */
export function pickForegroundMask(masks: readonly Plane[], seed: Point): Plane {
  let best = masks[0]
  let bestValue = -Infinity
  if (masks.length === 1) return best
  for (const mask of masks) {
    const value = meanAround(mask, seed, 2)
    if (value > bestValue) {
      best = mask
      bestValue = value
    }
  }
  return best
}

// ---- cleaning up the web engine's mask ---------------------------------------

/**
 * The confident core (conf ≥ threshold) as 0/1, split into 8-connected parts
 * with an explicit queue (never recursion, so a large garment cannot overflow
 * the stack). The part under the seed is the garment, or the largest part when
 * the seed is on none; any other part at least `keepShare` of its size stays
 * too, so both socks of a pair survive and specks do not.
 */
export function keepMainComponents(conf: Plane, threshold: number, keepShare: number, seed?: Point): Plane {
  const { width: w, height: h } = conf
  const n = w * h
  const label = new Int32Array(n)
  const queue = new Int32Array(n)
  const sizes = [0]
  for (let first = 0; first < n; first++) {
    if (label[first] || conf.data[first] < threshold) continue
    const id = sizes.length
    let head = 0
    let tail = 0
    label[first] = id
    queue[tail++] = first
    while (head < tail) {
      const i = queue[head++]
      const x = i % w
      const y = (i - x) / w
      for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
          const j = ny * w + nx
          if (!label[j] && conf.data[j] >= threshold) {
            label[j] = id
            queue[tail++] = j
          }
        }
      }
    }
    sizes.push(tail)
  }
  const out = new Float32Array(n)
  let largest = 0
  for (let id = 1; id < sizes.length; id++) if (sizes[id] > sizes[largest]) largest = id
  // the seed's part always stays; every other is measured against the largest,
  // so a seed on a logo or a cuff cannot let specks through
  const main = (seed && label[pixelAt(conf, seed)]) || largest
  const floor = sizes[largest] * keepShare
  for (let i = 0; i < n; i++) if (label[i] && (label[i] === main || sizes[label[i]] >= floor)) out[i] = 1
  return { width: w, height: h, data: out }
}

/**
 * Fill each hole in a 0/1 core that is smaller than `maxArea` and does not
 * reach the border: a pinhole where the duvet showed through goes, a bag's
 * handle opening stays. Holes are 4-connected, the digital partner of the
 * core's 8-connected parts.
 */
export function fillSmallHoles(core: Plane, maxArea: number): Plane {
  const { width: w, height: h } = core
  const n = w * h
  const out = new Float32Array(core.data)
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  for (let first = 0; first < n; first++) {
    if (seen[first] || core.data[first] >= 0.5) continue
    let head = 0
    let tail = 0
    let border = false
    seen[first] = 1
    queue[tail++] = first
    while (head < tail) {
      const i = queue[head++]
      const x = i % w
      const y = (i - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && core.data[j] < 0.5) {
          seen[j] = 1
          queue[tail++] = j
        }
      }
    }
    if (!border && tail < maxArea) for (let k = 0; k < tail; k++) out[queue[k]] = 1
  }
  return { width: w, height: h, data: out }
}

/**
 * The running max (or min) of radius r along one line of n values, the window
 * cut off at the ends. van Herk / Gil-Werman: a prefix and a suffix pass over
 * blocks of 2r + 1, so three comparisons a value whatever r is.
 */
function runLine(src: Float32Array, n: number, r: number, max: boolean, out: Float32Array, pre: Float32Array, suf: Float32Array): void {
  const k = 2 * r + 1
  const m = Math.ceil((n + 2 * r) / k) * k
  const pad = max ? -Infinity : Infinity
  const pick = (a: number, b: number) => (max ? (a > b ? a : b) : a < b ? a : b)
  for (let i = 0; i < m; i++) {
    const v = i < r || i >= r + n ? pad : src[i - r]
    pre[i] = i % k === 0 ? v : pick(pre[i - 1], v)
  }
  for (let i = m - 1; i >= 0; i--) {
    const v = i < r || i >= r + n ? pad : src[i - r]
    suf[i] = i % k === k - 1 ? v : pick(suf[i + 1], v)
  }
  for (let i = 0; i < n; i++) out[i] = pick(suf[i], pre[i + k - 1])
}

/** A square max (or min) filter of radius r, as two separable running passes. */
function morph(p: Plane, r: number, max: boolean): Plane {
  const { width: w, height: h } = p
  if (r <= 0) return { width: w, height: h, data: new Float32Array(p.data) }
  const longest = Math.max(w, h)
  const blocks = Math.ceil((longest + 2 * r) / (2 * r + 1)) * (2 * r + 1)
  const pre = new Float32Array(blocks)
  const suf = new Float32Array(blocks)
  const line = new Float32Array(longest)
  const res = new Float32Array(longest)
  const rows = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    runLine(p.data.subarray(y * w, y * w + w), w, r, max, res, pre, suf)
    rows.set(res.subarray(0, w), y * w)
  }
  const out = new Float32Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = rows[y * w + x]
    runLine(line, h, r, max, res, pre, suf)
    for (let y = 0; y < h; y++) out[y * w + x] = res[y]
  }
  return { width: w, height: h, data: out }
}

/** Grow by r pixels in every direction (a (2r + 1)² square). */
export const dilate = (p: Plane, r: number): Plane => morph(p, r, true)

/** Shrink by r pixels in every direction. The image's own edges do not eat into it. */
export const erode = (p: Plane, r: number): Plane => morph(p, r, false)

/**
 * The web engine's confidence mask, cleaned up for a garment on white:
 * 1. the core, with specks and stray neighbours dropped (keepMainComponents);
 * 2. pinholes filled (fillSmallHoles);
 * 3. min(conf, the core grown by 6) removes haze away from the garment, and
 *    max(that, the core shrunk by 3) makes the inside solid, so the bedding
 *    never shows through;
 * 4. smoothstep(0.3, 0.7) leaves mostly 0 or 1, with a soft rim of a pixel or two.
 */
export function refineMask(conf: Plane, seed?: Point): Plane {
  const { width, height } = conf
  const core = fillSmallHoles(keepMainComponents(conf, CUTOUT.coreThreshold, CUTOUT.keepShare, seed), CUTOUT.holeShare * width * height)
  const outer = dilate(core, CUTOUT.outerPx)
  const inner = erode(core, CUTOUT.innerPx)
  const out = new Float32Array(width * height)
  for (let i = 0; i < out.length; i++) {
    const a = Math.max(Math.min(conf.data[i], outer.data[i]), inner.data[i])
    out[i] = smoothstep(CUTOUT.edgeLo, CUTOUT.edgeHi, a)
  }
  return { width, height, data: out }
}

// ---- judging a mask ----------------------------------------------------------

export function maskStats(alpha: Uint8Array, width: number, height: number): MaskStats {
  let covered = 0
  let left = width
  let right = -1
  let top = height
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = alpha[y * width + x]
      if (a >= 128) covered++
      if (a < CUTOUT.boxAlphaMin) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  const box = right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
  const nearX = Math.max(CUTOUT.nearEdgePx, Math.round(width * CUTOUT.nearEdgeShare))
  const nearY = Math.max(CUTOUT.nearEdgePx, Math.round(height * CUTOUT.nearEdgeShare))
  const edgesTouched = box
    ? [box.x <= nearX, width - box.x - box.width <= nearX, box.y <= nearY, height - box.y - box.height <= nearY].filter(Boolean).length
    : 0
  return { coverage: covered / (width * height), box, edgesTouched }
}

/** Whether a mask looks like one garment: not nothing, not a speck, not the whole photo, not pressed into three sides. */
export function judgeMask(stats: MaskStats): MaskVerdict {
  if (!stats.box) return 'empty'
  if (stats.coverage < CUTOUT.tinyCoverage) return 'tiny'
  if (stats.coverage > CUTOUT.wholeCoverage) return 'whole-photo'
  if (stats.edgesTouched >= CUTOUT.frameEdges) return 'frame'
  return 'ok'
}

/**
 * The best of the seeds tried: the largest accepted mask; failing that the
 * first with anything in it, marked doubtful; null when every one was empty.
 */
export function pickBest<T extends { stats: MaskStats }>(candidates: readonly T[]): { pick: T; doubtful: boolean } | null {
  let best: T | null = null
  for (const c of candidates) if (judgeMask(c.stats) === 'ok' && (!best || c.stats.coverage > best.stats.coverage)) best = c
  if (best) return { pick: best, doubtful: false }
  const first = candidates.find(c => c.stats.box)
  return first ? { pick: first, doubtful: true } : null
}

// ---- the finish: the garment on white ----------------------------------------

/** The box grown by the same padding on all four sides: `ratio` of its long side, at least `min`. It may run past the photo. */
export function paddedBox(box: Box, ratio: number, min: number): Box {
  const pad = Math.max(min, Math.round(ratio * Math.max(box.width, box.height)))
  return { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad }
}

/**
 * The crop of `src`, laid over pure white by `alpha` (the same size as src):
 * out = round((a·c + (255 − a)·255) / 255). Opaque. Any part of the crop
 * outside the photo is white.
 */
export function compositeOnWhite(src: Rgba, alpha: Uint8Array, crop: Box): Rgba {
  const out = new Uint8ClampedArray(crop.width * crop.height * 4).fill(255)
  const x0 = Math.max(0, crop.x)
  const x1 = Math.min(src.width, crop.x + crop.width)
  const y0 = Math.max(0, crop.y)
  const y1 = Math.min(src.height, crop.y + crop.height)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * src.width + x
      const a = alpha[i]
      if (!a) continue
      const at = i * 4
      const o = ((y - crop.y) * crop.width + (x - crop.x)) * 4
      const white = (255 - a) * 255
      out[o] = Math.round((a * src.data[at] + white) / 255)
      out[o + 1] = Math.round((a * src.data[at + 1] + white) / 255)
      out[o + 2] = Math.round((a * src.data[at + 2] + white) / 255)
    }
  }
  return { width: crop.width, height: crop.height, data: out }
}

/**
 * The one finish for both engines: the tight box of the garment, padded evenly,
 * composited on white and area-resized to at most `outEdge` on its long side.
 * Null when the alpha holds no garment at all.
 */
export function finishOnWhite(src: Rgba, alpha: Uint8Array, outEdge: number): { image: Rgba; crop: Box; stats: MaskStats } | null {
  const stats = maskStats(alpha, src.width, src.height)
  if (!stats.box) return null
  const crop = paddedBox(stats.box, CUTOUT.padRatio, CUTOUT.padMin)
  const size = fitWithin(crop.width, crop.height, outEdge)
  return { image: resizeArea(compositeOnWhite(src, alpha, crop), size.width, size.height), crop, stats }
}

// ---- the preview's tap ---------------------------------------------------------

/**
 * Where a tap lands on an image drawn with `object-fit: contain`: `tap` is in
 * the box's own pixels, and the answer is normalised across the image. Null on
 * the empty bars beside or above it.
 */
export function pointInContainedImage(tap: Point, box: { width: number; height: number }, image: { width: number; height: number }): Point | null {
  if (!(box.width > 0 && box.height > 0 && image.width > 0 && image.height > 0)) return null
  const scale = Math.min(box.width / image.width, box.height / image.height)
  const w = image.width * scale
  const h = image.height * scale
  const x = (tap.x - (box.width - w) / 2) / w
  const y = (tap.y - (box.height - h) / 2) / h
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}
