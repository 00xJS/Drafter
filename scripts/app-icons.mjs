#!/usr/bin/env node
// Draws every app icon PNG from public/icon.svg: the iPhone's 1024 App Store
// icon, the web's apple-touch-icon and the two manifest sizes. Run it after
// touching public/icon.svg, with scripts/launch-logo.mjs for the launch screen:
//
//     node scripts/app-icons.mjs
//
// Chromium draws the SVG (Playwright's, installed for the browser tests), and
// the pixels are written here as RGB with no alpha channel: App Store Connect
// refuses an app icon that has one, and the icon's own dark square leaves
// nothing transparent to keep. Not part of `npm run check`: it needs a browser.
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const ICONS = [
  { file: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', size: 1024 },
  { file: 'public/apple-touch-icon.png', size: 180 },
  { file: 'public/icon-192.png', size: 192 },
  { file: 'public/icon-512.png', size: 512 },
]

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** An 8-bit RGB PNG (colour type 2) from RGBA pixels, the alpha dropped. */
export function rgbPng(size, rgba) {
  const rows = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3)
    rows[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = row + 1 + x * 3
      rows[to] = rgba[from]
      rows[to + 1] = rgba[from + 1]
      rows[to + 2] = rgba[from + 2]
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

async function main() {
  const svg = readFileSync(join(root, 'public/icon.svg'), 'utf8')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    for (const { file, size } of ICONS) {
      // the SVG drawn into a canvas of exactly this size, read back as RGBA
      const base64 = await page.evaluate(
        async ({ svg, size }) => {
          // this runs in the page, where the DOM is
          const { Image, document } = globalThis
          const img = new Image()
          img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
          await img.decode()
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('no 2d context')
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(img, 0, 0, size, size)
          const data = ctx.getImageData(0, 0, size, size).data
          let bin = ''
          for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
          return btoa(bin)
        },
        { svg, size },
      )
      const rgba = Buffer.from(base64, 'base64')
      writeFileSync(join(root, file), rgbPng(size, rgba))
      console.log(`${file}: ${size}x${size}`)
    }
  } finally {
    await browser.close()
  }
}

// compared as URLs: the repo path has a space, which import.meta.url spells %20
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
