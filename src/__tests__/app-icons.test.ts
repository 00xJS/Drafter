import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { ICONS, rgbPng } from '../../scripts/app-icons.mjs'

// The icon PNGs are written by scripts/app-icons.mjs as 8-bit RGB with no alpha
// channel: App Store Connect refuses an app icon that carries one.

/** The IHDR fields and the unfiltered rows of a PNG this writer made. */
function readBack(png: Buffer) {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(png.toString('ascii', 12, 16)).toBe('IHDR')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const depth = png[24]
  const colourType = png[25]
  const idatAt = png.indexOf('IDAT')
  const idatLength = png.readUInt32BE(idatAt - 4)
  const rows = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLength))
  return { width, height, depth, colourType, rows }
}

describe('the app icon writer', () => {
  it('writes an RGB PNG with no alpha, each row unfiltered, the pixels as given', () => {
    // 2x2: red, green / blue, white — each with an alpha that must be dropped
    const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255])
    const { width, height, depth, colourType, rows } = readBack(rgbPng(2, rgba))
    expect({ width, height, depth, colourType }).toEqual({ width: 2, height: 2, depth: 8, colourType: 2 })
    expect([...rows]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255])
  })

  it('draws the iPhone icon at 1024 and the web icons at their manifest sizes', () => {
    expect(ICONS.map(i => [i.file, i.size])).toEqual([
      ['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024],
      ['public/apple-touch-icon.png', 180],
      ['public/icon-192.png', 192],
      ['public/icon-512.png', 512],
    ])
  })
})
