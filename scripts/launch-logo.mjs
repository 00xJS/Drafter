#!/usr/bin/env node
// Draws ios/App/App/Assets.xcassets/LaunchLogo.imageset from public/icon.svg.
//
// The launch screen shows the app icon's MARK — the house in its atom, without
// the dark square the icon keeps — centred on the light ground the app opens
// in. Those two pictures drifted once already: the icon was replaced and the
// launch screen went on showing the old one, which nothing in the build
// noticed because iOS draws the storyboard before any code runs. So the mark
// is no longer drawn by hand. Run this after touching public/icon.svg:
//
//     node scripts/launch-logo.mjs
//
// macOS only, and deliberately not part of `npm run check`: it shells out to
// qlmanage. launchscreen.test.ts holds the result to what the storyboard and
// the icon say, so a stale run fails there rather than on a phone.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = `${root}/ios/App/App/Assets.xcassets/LaunchLogo.imageset`
/** 120pt square, at the three scales the imageset lists. */
const SIZES = [
  { size: 120, name: 'LaunchLogo.png' },
  { size: 240, name: 'LaunchLogo@2x.png' },
  { size: 360, name: 'LaunchLogo@3x.png' },
]
/** Room around the mark, in the icon's 512 units, so it is not flush to the edge. */
const MARGIN = 8

/*
 * QuickLook is the only rasteriser on a stock Mac, and it has two habits to
 * work around. It flattens onto an opaque ground, so every size is drawn twice
 * — once on white, once on black — and the alpha recovered from the pair:
 * white gives C·a + 255(1−a), black gives C·a, so subtracting one from the
 * other gives a, and the black draw is already the premultiplied colour.
 * And below about 360px it lays the drawing out wrongly, squeezing it into a
 * corner of the canvas, so everything is drawn at 3× and averaged down. That
 * second part is not just a workaround: supersampling is why the thin light
 * ring still has solid pixels at 120, where resampling a finished 360 would
 * have left it entirely translucent and the test asking for both of the
 * icon's oranges would fail on the 1x.
 */
const SUPERSAMPLE = 3

/** The icon without the square it sits on: the mark the launch screen shows. */
function mark() {
  const svg = readFileSync(`${root}/public/icon.svg`, 'utf8')
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '')
  const body = inner.replace(/\s*<rect\b[^>]*\/>/, '')
  if (body === inner) throw new Error('public/icon.svg has no ground <rect> to drop')
  const box = /viewBox="([^"]+)"/.exec(svg)?.[1]
  if (!box) throw new Error('public/icon.svg has no viewBox')
  return { body, box }
}

function raster(body, box, size, ground) {
  const dir = mkdtempSync(join(tmpdir(), 'launch-logo-'))
  try {
    const file = join(dir, 'm.svg')
    const [x, y, w, h] = box.split(/[\s,]+/)
    writeFileSync(
      file,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="${size}" height="${size}">` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${ground}"/>${body}</svg>`,
    )
    execFileSync('qlmanage', ['-t', '-s', String(size), '-o', dir, file], { stdio: 'ignore' })
    const png = readPng(join(dir, 'm.svg.png'))
    if (png.width !== size || png.height !== size) throw new Error(`qlmanage returned ${png.width}x${png.height}, wanted ${size}`)
    return png
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** One window at `size`, as premultiplied RGB plus the alpha the pair gives. */
function draw(body, box, size) {
  const white = raster(body, box, size, '#ffffff')
  const black = raster(body, box, size, '#000000')
  return (x, y) => {
    const w = white.pixel(x, y)
    const b = black.pixel(x, y)
    let a = 0
    for (let i = 0; i < 3; i++) a = Math.max(a, 255 - (w[i] - b[i]))
    return [b[0], b[1], b[2], Math.min(255, Math.max(0, a))] // premultiplied, then alpha
  }
}

/**
 * The window to draw: a square centred on the mark's own middle, big enough to
 * hold it. Measured from a draw rather than read off the icon, because a path's
 * bounding box is not something to work out by hand — and because the storyboard
 * centres the image view, so a mark that is not in the middle of its canvas is
 * not in the middle of the screen.
 */
function squareWindow(body, box) {
  const probe = 512
  const at = draw(body, box, probe)
  const [x0, y0, side] = box.split(/[\s,]+/).map(Number)
  const unit = side / probe
  let [left, right, top, bottom] = [probe, -1, probe, -1]
  for (let y = 0; y < probe; y++) {
    for (let x = 0; x < probe; x++) {
      if (!at(x, y)[3]) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) throw new Error('the mark drew nothing')
  const cx = x0 + ((left + right + 1) / 2) * unit
  const cy = y0 + ((top + bottom + 1) / 2) * unit
  const half = Math.max(right - left + 1, bottom - top + 1) * unit * 0.5 + MARGIN
  return { box: `${cx - half} ${cy - half} ${half * 2} ${half * 2}`, bbox: { left, right, top, bottom } }
}

// --- PNG, both ways -------------------------------------------------------

/** 8-bit PNG without interlacing, RGB or RGBA — what qlmanage writes. */
function readPng(file) {
  const buf = readFileSync(file)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bpp = buf[25] === 6 ? 4 : 3
  const idat = []
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at)
    if (buf.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = new Uint8Array(stride * height)
  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++]
    for (let x = 0; x < stride; x++, at++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0
      const pa = Math.abs(b - c)
      const pb = Math.abs(a - c)
      const pc = Math.abs(a + b - 2 * c)
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      px[y * stride + x] = (raw[at] + [0, a, b, (a + b) >> 1, paeth][filter]) & 0xff
    }
  }
  return { width, height, pixel: (x, y) => [...px.subarray((y * width + x) * bpp, (y * width + x) * bpp + bpp)] }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = buf => (buf.reduce((c, b) => crcTable[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

/** 8-bit RGBA, no interlacing, every row filtered None — what the test reads. */
function writePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- and the run ----------------------------------------------------------

const { body, box } = mark()
const win = squareWindow(body, box)
console.log(`mark ${win.bbox.left}..${win.bbox.right} x ${win.bbox.top}..${win.bbox.bottom} of 512 -> viewBox "${win.box}"`)

for (const { size, name } of SIZES) {
  const big = size * SUPERSAMPLE
  const at = draw(body, win.box, big)
  const out = Buffer.alloc(size * size * 4)
  const n = SUPERSAMPLE * SUPERSAMPLE
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // averaged premultiplied, or a transparent pixel's colour would drag
      // the average towards black and leave a dark fringe round the mark
      const sum = [0, 0, 0, 0]
      for (let dy = 0; dy < SUPERSAMPLE; dy++) {
        for (let dx = 0; dx < SUPERSAMPLE; dx++) {
          const p = at(x * SUPERSAMPLE + dx, y * SUPERSAMPLE + dy)
          for (let i = 0; i < 4; i++) sum[i] += p[i]
        }
      }
      const a = Math.round(sum[3] / n)
      if (!a) continue
      const to = (y * size + x) * 4
      for (let i = 0; i < 3; i++) out[to + i] = Math.min(255, Math.max(0, Math.round(sum[i] / n / (a / 255))))
      out[to + 3] = a
    }
  }
  writeFileSync(`${OUT}/${name}`, writePng(size, out))
  console.log(`${name}  ${size}x${size}`)
}
