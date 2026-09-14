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
 * The web engine's mask gets two more steps on the way: its edge is moved onto
 * the photo's own (snapToEdges, a guided filter on luma), and its rim takes
 * the garment's colour rather than the floor's (estimateForeground). The
 * heavy steps run in a worker (src/cutoutjobs.ts), so the page keeps drawing.
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
  // Vision's subjects on the iPhone: what stays beside the largest (both shoes of
  // a pair), the least of the frame a garment beside the ground can be (a
  // trainer across the room is 1–2%), how much of the ring round a garment's
  // box must be one subject for the garment to lie on it, and the ring, in the
  // instance mask's own pixels, that goes with one left out
  subjectShare: 0.2,
  subjectSpeck: 0.004,
  groundRingShare: 0.5,
  subjectFringePx: 2,
  // snapToEdges (the web engine's mask, on the work photo): the guided filter's
  // radius and smoothing (on luma 0..1, so 0.001 answers to a step of about
  // 0.03), and how far either side of the mask's edge it may move it
  snapRadius: 8,
  snapEps: 0.001,
  snapBandPx: 6,
  // estimateForeground: the radii of its two passes, wide and then fine
  defringePx: [24, 4],
  // looksCutOut: a cut-out's outermost pixels, white near enough, nearly all round
  cutBorderPx: 2,
  cutWhiteMin: 245,
  cutWhiteShare: 0.98,
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

/**
 * Vision's frame (a JPEG, opaque) with its subjects' mask (the alpha of a
 * PNG) laid in: the frame's colours and the mask's alpha, which is what the
 * lifted subjects on transparency were. A mask of another size is stretched
 * to the frame.
 */
export function joinAlpha(frame: Rgba, mask: Rgba): Rgba {
  const out = new Uint8ClampedArray(frame.data)
  let alpha = alphaOf(mask)
  if (mask.width !== frame.width || mask.height !== frame.height) {
    const plane = { width: mask.width, height: mask.height, data: Float32Array.from(alpha, a => a / 255) }
    alpha = planeToAlpha(resizePlaneBilinear(plane, frame.width, frame.height))
  }
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = alpha[i]
  return { width: frame.width, height: frame.height, data: out }
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

/**
 * Several masks as one, each pixel as sure as the surest of them: the web
 * engine's answer to several taps, so both shoes of a pair stay. They are all
 * made at the one mask size.
 */
export function unionPlanes(planes: readonly Plane[]): Plane {
  const [first, ...rest] = planes
  const out = new Float32Array(first.data)
  for (const p of rest) {
    if (p.width !== first.width || p.height !== first.height) throw new Error('unionPlanes: masks of different sizes')
    for (let i = 0; i < out.length; i++) if (p.data[i] > out[i]) out[i] = p.data[i]
  }
  return { width: first.width, height: first.height, data: out }
}

// ---- the web engine's edge -----------------------------------------------------

/** Rec. 601 luma of one pixel, 0..1: the guide snapToEdges follows. */
const lumaAt = (data: Uint8ClampedArray, i: number) => (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255

/**
 * A summed-area table of a w × h field, (w + 1) × (h + 1) with a row and a
 * column of zeros first: the sum over any rectangle is then four reads
 * (sumIn). Written into `into` when it is given and big enough.
 */
function summed(field: ArrayLike<number>, w: number, h: number, into?: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
  const stride = w + 1
  const sat = into && into.length >= stride * (h + 1) ? into : new Float64Array(stride * (h + 1))
  sat.fill(0, 0, stride)
  for (let y = 0; y < h; y++) {
    const above = y * stride
    const here = above + stride
    let run = 0
    sat[here] = 0
    for (let x = 0; x < w; x++) {
      run += field[y * w + x]
      sat[here + x + 1] = sat[above + x + 1] + run
    }
  }
  return sat
}

/** The sum of a summed-area table's field over columns x0 up to x1 and rows y0 up to y1, the ends not included. */
const sumIn = (sat: Float64Array, stride: number, x0: number, y0: number, x1: number, y1: number) =>
  sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0]

/**
 * The mean of a plane over a (2r + 1)² window, cut off at the image's edges,
 * where fewer pixels count. Prefix sums along the rows and then the columns,
 * so the cost does not grow with r.
 */
export function boxMean(p: Plane, r: number): Plane {
  const { width: w, height: h } = p
  const sums = new Float64Array(Math.max(w, h) + 1)
  const rows = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) sums[x + 1] = sums[x] + p.data[row + x]
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r)
      const hi = Math.min(w, x + r + 1)
      rows[row + x] = (sums[hi] - sums[lo]) / (hi - lo)
    }
  }
  const out = new Float32Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) sums[y + 1] = sums[y] + rows[y * w + x]
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r)
      const hi = Math.min(h, y + r + 1)
      out[y * w + x] = (sums[hi] - sums[lo]) / (hi - lo)
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * The guided filter's two answers: the input remade, window by window, as a
 * straight-line function of the guide (so it can change only where the guide
 * does), and how clear an edge the guide has round each pixel, from 0 where
 * it is flat to nearly 1 where its variance is well over eps.
 */
function guided(guide: Plane, input: Plane, r: number, eps: number): { q: Plane; edge: Plane } {
  const { width, height } = guide
  const n = width * height
  const plane = (data: Float32Array): Plane => ({ width, height, data })
  const products = new Float32Array(n)
  for (let i = 0; i < n; i++) products[i] = guide.data[i] * guide.data[i]
  const meanII = boxMean(plane(products), r).data
  for (let i = 0; i < n; i++) products[i] = guide.data[i] * input.data[i]
  const meanIP = boxMean(plane(products), r).data
  const meanI = boxMean(guide, r).data
  const meanP = boxMean(input, r).data
  const a = new Float32Array(n)
  const b = new Float32Array(n)
  const edge = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const variance = Math.max(0, meanII[i] - meanI[i] * meanI[i])
    a[i] = (meanIP[i] - meanI[i] * meanP[i]) / (variance + eps)
    b[i] = meanP[i] - a[i] * meanI[i]
    edge[i] = variance / (variance + eps)
  }
  const meanA = boxMean(plane(a), r).data
  const meanB = boxMean(plane(b), r).data
  const q = new Float32Array(n)
  for (let i = 0; i < n; i++) q[i] = meanA[i] * guide.data[i] + meanB[i]
  return { q: plane(q), edge: boxMean(plane(edge), r) }
}

/** He, Sun and Tang's guided filter: `input` smoothed so that its edges follow the guide's. */
export const guidedFilter = (guide: Plane, input: Plane, r: number, eps: number): Plane => guided(guide, input, r, eps).q

/**
 * The web engine's mask, moved onto the photo's own edges. It is refined at
 * 1024 px and grown to the work photo, so its edge is soft and can sit a
 * pixel or two off the garment's. Within CUTOUT.snapBandPx of that edge, a
 * guided filter on the photo's luma puts it where the photo really changes,
 * and the smoothstep refineMask ends with makes it as crisp again. Where the
 * photo is flat there (a garment the tone of the floor), there is nothing to
 * follow, and the mask stays as it was; further in and further out, nothing
 * changes. The same alpha back when it has no edge at all.
 */
export function snapToEdges(src: Rgba, alpha: Uint8Array): Uint8Array {
  const { width: w, height: h } = src
  const b = CUTOUT.snapBandPx
  const hard = new Uint8Array(w * h)
  for (let i = 0; i < hard.length; i++) hard[i] = alpha[i] >= 128 ? 1 : 0
  // the band: each pixel with both garment and ground within snapBandPx of it
  const sat = summed(hard, w, h)
  const band = new Uint8Array(w * h)
  let [left, top, right, bottom] = [w, h, -1, -1]
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - b)
    const yb = Math.min(h, y + b + 1)
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - b)
      const xb = Math.min(w, x + b + 1)
      const garment = sumIn(sat, w + 1, xa, ya, xb, yb)
      if (garment === 0 || garment === (xb - xa) * (yb - ya)) continue
      band[y * w + x] = 1
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) return alpha
  // the band, and round it everything the filter reads: two windows of snapRadius
  const reach = 2 * CUTOUT.snapRadius + 1
  const x0 = Math.max(0, left - reach)
  const y0 = Math.max(0, top - reach)
  const rw = Math.min(w, right + reach + 1) - x0
  const rh = Math.min(h, bottom + reach + 1) - y0
  const guide = new Float32Array(rw * rh)
  const input = new Float32Array(rw * rh)
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const s = (y0 + y) * w + x0 + x
      guide[y * rw + x] = lumaAt(src.data, s)
      input[y * rw + x] = alpha[s] / 255
    }
  }
  const { q, edge } = guided({ width: rw, height: rh, data: guide }, { width: rw, height: rh, data: input }, CUTOUT.snapRadius, CUTOUT.snapEps)
  const out = new Uint8Array(alpha)
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const s = (y0 + y) * w + x0 + x
      if (!band[s]) continue
      // the photo's edge where it has one, the mask as it was where it has none
      const j = y * rw + x
      const t = edge.data[j]
      out[s] = Math.round((t * smoothstep(CUTOUT.edgeLo, CUTOUT.edgeHi, q.data[j]) + (1 - t) * input[j]) * 255)
    }
  }
  return out
}

// ---- judging a mask ----------------------------------------------------------

/** How many sides of a width × height image `box` comes within max(2 px, 1%) of. */
function sidesTouched(box: Box, width: number, height: number): number {
  const nearX = Math.max(CUTOUT.nearEdgePx, Math.round(width * CUTOUT.nearEdgeShare))
  const nearY = Math.max(CUTOUT.nearEdgePx, Math.round(height * CUTOUT.nearEdgeShare))
  return [box.x <= nearX, width - box.x - box.width <= nearX, box.y <= nearY, height - box.y - box.height <= nearY].filter(Boolean).length
}

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
  return { coverage: covered / (width * height), box, edgesTouched: box ? sidesTouched(box, width, height) : 0 }
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
 * The garment's own colour at its soft edge. A pixel on the rim of a mask is
 * part garment and part ground, so laid on white as it is, a dark floor shows
 * as a dark fringe round the garment. This is Forte and Pitié's blur fusion:
 * the garment's colour near a pixel is the mean of the colours round it
 * weighted by their alpha, the ground's the mean weighted by what alpha
 * leaves, and the pixel's own colour is then shared out between the two. Two
 * passes, wide and then fine (CUTOUT.defringePx), a colour at a time. Only
 * the rim changes, the pixels inside `box` with some alpha but not all of it,
 * so the sums round them come from summed-area tables and nothing else is
 * worked out; the rest of the copy is `src` as it was.
 */
export function estimateForeground(src: Rgba, alpha: Uint8Array, box: Box): Rgba {
  const out = new Uint8ClampedArray(src.data)
  const done = { width: src.width, height: src.height, data: out }
  const bx0 = Math.max(0, box.x)
  const by0 = Math.max(0, box.y)
  const bx1 = Math.min(src.width, box.x + box.width)
  const by1 = Math.min(src.height, box.y + box.height)
  // the box, and round it what the widest pass reads
  const reach = Math.max(...CUTOUT.defringePx)
  const x0 = Math.max(0, bx0 - reach)
  const y0 = Math.max(0, by0 - reach)
  const w = Math.max(0, Math.min(src.width, bx1 + reach) - x0)
  const h = Math.max(0, Math.min(src.height, by1 + reach) - y0)
  const rim: number[] = []
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const a = alpha[y * src.width + x]
      if (a > 0 && a < 255) rim.push((y - y0) * w + (x - x0))
    }
  }
  if (!rim.length) return done
  const n = w * h
  const stride = w + 1
  const a = new Float32Array(n)
  const rest = new Float32Array(n)
  const image = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      a[y * w + x] = alpha[(y0 + y) * src.width + x0 + x] / 255
      rest[y * w + x] = 1 - a[y * w + x]
    }
  }
  const sureF = summed(a, w, h)
  const sureB = summed(rest, w, h)
  const fg = new Float32Array(n)
  const bg = new Float32Array(n)
  const weighted = new Float32Array(n)
  let sumF = new Float64Array(0)
  let sumB = new Float64Array(0)
  const nextF = new Float32Array(rim.length)
  const nextB = new Float32Array(rim.length)
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) image[y * w + x] = src.data[((y0 + y) * src.width + x0 + x) * 4 + c] / 255
    fg.set(image)
    bg.set(image)
    for (const r of CUTOUT.defringePx) {
      for (let i = 0; i < n; i++) weighted[i] = fg[i] * a[i]
      sumF = summed(weighted, w, h, sumF)
      for (let i = 0; i < n; i++) weighted[i] = bg[i] * rest[i]
      sumB = summed(weighted, w, h, sumB)
      for (let k = 0; k < rim.length; k++) {
        const i = rim[k]
        const x = i % w
        const y = (i - x) / w
        const [xa, ya, xb, yb] = [Math.max(0, x - r), Math.max(0, y - r), Math.min(w, x + r + 1), Math.min(h, y + r + 1)]
        const weightF = sumIn(sureF, stride, xa, ya, xb, yb)
        const weightB = sumIn(sureB, stride, xa, ya, xb, yb)
        // far from any garment (or any ground) there is nothing to weigh, and the estimate stays
        const f = weightF > 1e-6 ? sumIn(sumF, stride, xa, ya, xb, yb) / weightF : fg[i]
        const g = weightB > 1e-6 ? sumIn(sumB, stride, xa, ya, xb, yb) / weightB : bg[i]
        const residual = image[i] - a[i] * f - rest[i] * g
        nextF[k] = Math.min(1, Math.max(0, f + a[i] * residual))
        nextB[k] = Math.min(1, Math.max(0, g + rest[i] * residual))
      }
      // An opaque pixel's own colour is its garment colour, and a clear one's
      // its ground's; the other estimate there has no weight. So only the rim
      // moves, and every pass reads the one before it whole.
      for (let k = 0; k < rim.length; k++) {
        fg[rim[k]] = nextF[k]
        bg[rim[k]] = nextB[k]
      }
    }
    for (const i of rim) {
      const x = i % w
      out[((y0 + (i - x) / w) * src.width + x0 + x) * 4 + c] = Math.round(fg[i] * 255)
    }
  }
  return done
}

/**
 * The one finish for both engines: the tight box of the garment, padded evenly,
 * composited on white and area-resized to at most `outEdge` on its long side.
 * `defringe` first gives the rim the garment's own colour (estimateForeground),
 * for the web engine, whose mask is drawn over the garment's ground. Null
 * when the alpha holds no garment at all.
 */
export function finishOnWhite(src: Rgba, alpha: Uint8Array, outEdge: number, opts: { defringe?: boolean } = {}): { image: Rgba; crop: Box; stats: MaskStats } | null {
  const stats = maskStats(alpha, src.width, src.height)
  if (!stats.box) return null
  const crop = paddedBox(stats.box, CUTOUT.padRatio, CUTOUT.padMin)
  const colours = opts.defringe ? estimateForeground(src, alpha, crop) : src
  const size = fitWithin(crop.width, crop.height, outEdge)
  return { image: resizeArea(compositeOnWhite(colours, alpha, crop), size.width, size.height), crop, stats }
}

// ---- Vision's subjects (the iPhone) --------------------------------------------

/**
 * Vision's instance mask: a byte a pixel, 0 for the background and 1…n for
 * each subject it found. Its resolution is its own (512 × 512 on every run so
 * far) and it is stretched over the whole frame, so a normalised point of the
 * frame lands on it directly.
 */
export interface InstanceMask {
  width: number
  height: number
  data: Uint8Array
}

/** One of Vision's subjects, measured on the instance mask. */
export interface Subject {
  label: number
  /** The share of the frame it covers. */
  area: number
  box: Box
  /** How many sides of the frame it comes within max(2 px, 1%) of. */
  edgesTouched: number
}

/** A mask worth reading: a byte for every pixel it says it has. */
export const usableMask = (mask: InstanceMask | null | undefined): mask is InstanceMask =>
  !!mask && mask.width > 0 && mask.height > 0 && mask.data.length === mask.width * mask.height

/** Every subject in the mask, by label. */
export function subjectsIn(mask: InstanceMask): Subject[] {
  const { width: w, height: h, data } = mask
  const count = new Int32Array(256)
  const left = new Int32Array(256).fill(w)
  const right = new Int32Array(256).fill(-1)
  const top = new Int32Array(256).fill(h)
  const bottom = new Int32Array(256).fill(-1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const label = data[y * w + x]
      if (!label) continue
      count[label]++
      if (x < left[label]) left[label] = x
      if (x > right[label]) right[label] = x
      if (y < top[label]) top[label] = y
      if (y > bottom[label]) bottom[label] = y
    }
  }
  const subjects: Subject[] = []
  for (let label = 1; label < 256; label++) {
    if (!count[label]) continue
    const box = { x: left[label], y: top[label], width: right[label] - left[label] + 1, height: bottom[label] - top[label] + 1 }
    subjects.push({ label, area: count[label] / (w * h), box, edgesTouched: sidesTouched(box, w, h) })
  }
  return subjects
}

/** The subject under a normalised point of the frame; 0 on the background. */
export function subjectAt(mask: InstanceMask, at: Point): number {
  return mask.data[pixelAt(mask, at)]
}

/**
 * How much of the ring just outside `box` (as far out as "near" a side of the
 * frame is) is subject `label`, of the ring's pixels that are that subject or
 * the background. Another subject's pixels count for neither: the other shoe
 * of a pair stands on the same rug.
 */
function ringShare(mask: InstanceMask, box: Box, label: number): number {
  const { width: w, height: h, data } = mask
  const d = Math.max(CUTOUT.nearEdgePx, Math.round(Math.max(w, h) * CUTOUT.nearEdgeShare))
  const [left, top, right, bottom] = [box.x - d, box.y - d, box.x + box.width - 1 + d, box.y + box.height - 1 + d]
  let on = 0
  let seen = 0
  const look = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const at = data[y * w + x]
    if (at === label) on++
    if (at === label || at === 0) seen++
  }
  for (let x = left; x <= right; x++) {
    look(x, top)
    look(x, bottom)
  }
  for (let y = top + 1; y < bottom; y++) {
    look(left, y)
    look(right, y)
  }
  return seen ? on / seen : 0
}

/**
 * The subjects a garment lies on. Any pressed into three or more sides of the
 * frame (a rug, the bed, a door); and the one pressed into the most sides, two
 * and more than any other, when something more than a speck lies on it,
 * mostly ringed by it: the rug in a corner of the photo, with the trainers on
 * it. Jeans from waistband to hem touch two sides too, but a shoe beside them
 * lies on the floor, so they are no ground.
 */
function groundOf(mask: InstanceMask, subjects: readonly Subject[]): Set<number> {
  const ground = new Set(subjects.filter(s => s.edgesTouched >= CUTOUT.frameEdges).map(s => s.label))
  const most = Math.max(...subjects.map(s => s.edgesTouched))
  const pressed = subjects.filter(s => s.edgesTouched === most)
  if (most === 2 && pressed.length === 1) {
    const [under] = pressed
    const onIt = subjects.some(s => s.edgesTouched < most && s.area >= CUTOUT.subjectSpeck && ringShare(mask, s.box, under.label) >= CUTOUT.groundRingShare)
    if (onIt) ground.add(under.label)
  }
  return ground
}

/**
 * Which of Vision's subjects are the garment, with no tap to go by. The
 * ground a garment lies on (groundOf) gives way to any other subject more than
 * a speck; of those, each at least a fifth the size of the largest stays, so
 * both shoes of a pair do, however large the rug under them. When nothing but
 * ground and specks is left, all the ground stays, since a garment can fill
 * the frame; that is doubtful only when there was a choice to make. Null when
 * the mask holds no subject.
 */
export function chooseSubjects(mask: InstanceMask): { keep: number[]; doubtful: boolean } | null {
  const subjects = subjectsIn(mask)
  if (!subjects.length) return null
  const ground = groundOf(mask, subjects)
  const garments = subjects.filter(s => !ground.has(s.label) && s.area >= CUTOUT.subjectSpeck)
  if (garments.length) {
    const largest = Math.max(...garments.map(s => s.area))
    return { keep: garments.filter(s => s.area >= largest * CUTOUT.subjectShare).map(s => s.label), doubtful: false }
  }
  const pool = ground.size ? subjects.filter(s => ground.has(s.label)) : subjects
  return { keep: pool.map(s => s.label), doubtful: subjects.length > 1 }
}

/**
 * What a tap picks: the subject under it, alone, even ground Vision was told
 * to leave out. Null on the background, and on the one subject the cut-out
 * already shows, where Vision has nothing more to offer (trainers it saw as one
 * with the rug they stand on): the web engine takes the tap then.
 */
export function subjectForTap(mask: InstanceMask, tap: Point, shown: readonly number[]): number[] | null {
  const label = subjectAt(mask, tap)
  return label && !(shown.length === 1 && shown[0] === label) ? [label] : null
}

/**
 * The frame's alpha (every subject on transparency) with only the kept
 * subjects left. Where a kept subject meets the background, Vision's own soft
 * edge stays exactly as it is. A subject left out goes, with a ring of
 * CUTOUT.subjectFringePx mask pixels round it, so no ghost of its edge is left
 * to widen the crop. Where a kept subject meets one left out (trainers on a
 * rug Vision told apart), the instance mask, grown to the frame bilinearly,
 * draws the line. The same alpha back when nothing is left out.
 */
export function keepSubjects(alpha: Uint8Array, width: number, height: number, mask: InstanceMask, keep: readonly number[]): Uint8Array {
  const kept = new Set(keep)
  const n = mask.width * mask.height
  const keptIn = new Float32Array(n)
  const leftOut = new Float32Array(n)
  let dropping = false
  for (let i = 0; i < n; i++) {
    const label = mask.data[i]
    if (!label) continue
    if (kept.has(label)) keptIn[i] = 1
    else {
      leftOut[i] = 1
      dropping = true
    }
  }
  if (!dropping) return alpha
  const nearKept = dilate({ width: mask.width, height: mask.height, data: keptIn }, CUTOUT.subjectFringePx).data
  const nearOut = dilate({ width: mask.width, height: mask.height, data: leftOut }, CUTOUT.subjectFringePx).data
  // 1 where the frame's alpha stays: a kept subject, and the background, unless
  // it is the ring round a subject left out with no kept one as near
  const stays = new Float32Array(n)
  for (let i = 0; i < n; i++) stays[i] = keptIn[i] === 1 || (leftOut[i] === 0 && (nearKept[i] === 1 || nearOut[i] === 0)) ? 1 : 0
  const grown = resizePlaneBilinear({ width: mask.width, height: mask.height, data: stays }, width, height).data
  const out = new Uint8Array(alpha.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(alpha[i] * grown[i])
  return out
}

/**
 * What several taps keep: the subjects under them, when every tap is on one
 * and they name two or more (both shoes of a pair, after a tap picked only
 * one). Null, and the web engine takes the taps, when one is on the
 * background, or when every one is on a single subject, which Vision cannot
 * split any further (trainers it saw as one with their rug). One tap is
 * subjectForTap's.
 */
export function subjectsForTaps(mask: InstanceMask, taps: readonly Point[], shown: readonly number[]): number[] | null {
  if (taps.length === 1) return subjectForTap(mask, taps[0], shown)
  const labels = taps.map(t => subjectAt(mask, t))
  if (!labels.length || labels.includes(0)) return null
  const distinct = [...new Set(labels)].sort((a, b) => a - b)
  return distinct.length >= 2 ? distinct : null
}

/** A point on a subject, normalised: its pixel nearest the middle of its box. Null when the mask holds none of it. */
export function subjectPoint(mask: InstanceMask, label: number): Point | null {
  const { width: w, height: h, data } = mask
  let [left, top, right, bottom] = [w, h, -1, -1]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] !== label) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) return null
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  let best = { x: left, y: top, d: Infinity }
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2
      if (data[y * w + x] === label && d < best.d) best = { x, y, d }
    }
  }
  return { x: (best.x + 0.5) / w, y: (best.y + 0.5) / h }
}

/**
 * Vision's lift as the cut-out uses it: which subjects, the frame's alpha
 * with only them left, and a point on each thing kept, which the preview adds
 * a tap to when one more thing should stay. Taps pick by subjectsForTaps and
 * are those points; without any, chooseSubjects decides and each kept subject
 * gets its subjectPoint. With no mask to read, or none that holds a subject,
 * everything Vision lifted stays (`keep` empty). Null only for taps Vision
 * has nothing for, which the web engine then takes.
 */
export function liftedAlpha(
  src: Rgba,
  mask: InstanceMask | null,
  taps: readonly Point[],
  shown: readonly number[],
): { alpha: Uint8Array; keep: number[]; doubtful: boolean; points: Point[] } | null {
  const alpha = alphaOf(src)
  if (taps.length) {
    const keep = mask ? subjectsForTaps(mask, taps, shown) : null
    return mask && keep ? { alpha: keepSubjects(alpha, src.width, src.height, mask, keep), keep, doubtful: false, points: [...taps] } : null
  }
  const choice = mask ? chooseSubjects(mask) : null
  if (!mask || !choice) return { alpha, keep: [], doubtful: false, points: [] }
  const points = choice.keep.map(label => subjectPoint(mask, label)).filter((p): p is Point => !!p)
  return { alpha: keepSubjects(alpha, src.width, src.height, mask, choice.keep), keep: choice.keep, doubtful: choice.doubtful, points }
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

// ---- a photo that is a cut-out already -----------------------------------------

/**
 * Whether a photo is a cut-out already. finishOnWhite pads every one with pure
 * white on all four sides, so its outermost pixels are white all the way
 * round (near enough, after a JPEG or two and a thumbnail's resize). A photo
 * of a garment on a bed, a floor or a door is not, even on a white sheet,
 * whose white is never that white from edge to edge.
 */
export function looksCutOut(img: Rgba): boolean {
  const { width: w, height: h, data } = img
  const ring = Math.min(CUTOUT.cutBorderPx, Math.floor(Math.min(w, h) / 2))
  if (ring < 1) return false
  let seen = 0
  let white = 0
  const look = (i: number) => {
    seen++
    if (Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= CUTOUT.cutWhiteMin) white++
  }
  for (let y = 0; y < h; y++) {
    if (y < ring || y >= h - ring) for (let x = 0; x < w; x++) look(y * w + x)
    else {
      for (let k = 0; k < ring; k++) {
        look(y * w + k)
        look(y * w + w - 1 - k)
      }
    }
  }
  return white >= seen * CUTOUT.cutWhiteShare
}
