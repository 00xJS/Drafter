import { describe, expect, it } from 'vitest'
import { typeScaleFor } from '../native'

// watchTextSize() reads a hidden `font: -apple-system-body` probe — the only
// place WKWebView exposes the reader's Dynamic Type setting — and turns its
// computed pixel size into the `--type-scale` the stylesheet multiplies by.
// The measurement needs a web view; the arithmetic does not, so it lives here.
describe('Dynamic Type: the scale the OS drives', () => {
  it('is exactly 1 at the iOS body baseline, so nothing moves by default', () => {
    expect(typeScaleFor(17)).toBe(1)
  })

  it('follows the reader between the two ends of the ramp', () => {
    // iOS Large (the default) through the top of the non-accessibility sizes
    expect(typeScaleFor(20)).toBeCloseTo(1.176, 3)
    expect(typeScaleFor(23)).toBeCloseTo(1.353, 3)
    expect(typeScaleFor(15.3)).toBeCloseTo(0.9, 3)
  })

  it('clamps: the accessibility sizes would otherwise break the chrome', () => {
    // xxxLarge accessibility body is 53px — 3.1x, which no five-tab bar survives
    expect(typeScaleFor(53)).toBe(1.6)
    expect(typeScaleFor(1000)).toBe(1.6)
    // and the smallest setting must still leave a tappable app
    expect(typeScaleFor(11)).toBe(0.9)
  })

  it('falls back to 1 when the probe cannot be measured', () => {
    // getComputedStyle on a detached or display:none tree gives '' -> NaN, and
    // a font-size of 0 would divide the whole app away
    expect(typeScaleFor(Number.NaN)).toBe(1)
    expect(typeScaleFor(0)).toBe(1)
    expect(typeScaleFor(-4)).toBe(1)
  })

  it('rounds finer than a Dynamic Type step, so the CSS value stays short', () => {
    expect(String(typeScaleFor(19))).toBe('1.118')
  })
})
