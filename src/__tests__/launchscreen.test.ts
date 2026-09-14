import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { THEME_GROUND, THEME_PREFS } from '../theme'

/*
 * iOS draws the launch screen from its storyboard before any code runs, and
 * SceneDelegate lays the same storyboard over the App Switcher card. A missing
 * image there is an empty screen on every cold start and nothing in the build
 * fails, so the storyboard, the asset catalog and the artwork are checked here
 * against each other and against public/icon.svg. The ground under the plane is
 * the light one the app opens in (THEME_GROUND.light), held equal here to every
 * other copy of it: the web view's, the manifest's, the meta's and SceneDelegate's.
 */

const path = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const read = (rel: string) => readFileSync(path(rel), 'utf8')
const APP = 'ios/App/App'
const CATALOG = `${APP}/Assets.xcassets`

const storyboard = read(`${APP}/Base.lproj/LaunchScreen.storyboard`)
const icon = read('public/icon.svg')

/** Every `name="value"` pair of one tag's attributes. */
const attrs = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([\w.]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))

const hex = (rgb: number[]) => `#${rgb.map(n => n.toString(16).padStart(2, '0')).join('')}`
/** An Interface Builder `red=".." green=".." blue=".."` colour as #rrggbb. */
const ibColour = (a: Record<string, string>) => hex([a.red, a.green, a.blue].map(v => Math.round(Number(v) * 255)))

/** The plane's two fills in the icon (whose rounded rect keeps its own dark ground). */
const planeFills = [...icon.matchAll(/<path\b[^>]*fill="(#[0-9a-f]{6})"/g)].map(m => m[1])

/**
 * A PNG's size and pixels. Only 8-bit RGBA without interlacing, which is what an
 * image with a transparent ground is exported as; anything else fails here.
 */
function readPng(file: string) {
  const buf = readFileSync(file)
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  expect({ depth: buf[24], colour: buf[25], interlace: buf[28] }).toEqual({ depth: 8, colour: 6, interlace: 0 })
  const idat: Buffer[] = []
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at)
    if (buf.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const px = new Uint8Array(stride * height)
  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++]
    expect(filter).toBeLessThanOrEqual(4)
    for (let x = 0; x < stride; x++, at++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0
      const pa = Math.abs(b - c)
      const pb = Math.abs(a - c)
      const pc = Math.abs(a + b - 2 * c)
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      px[y * stride + x] = (raw[at] + [0, a, b, (a + b) >> 1, paeth][filter]) & 0xff
    }
  }
  const pixel = (x: number, y: number) => [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
  return { width, height, pixel }
}

describe('Launch screen', () => {
  const root = attrs(/<view key="view"[^>]*>/.exec(storyboard)![0])
  const logoTag = /<imageView\b[^>]*>([\s\S]*?)<\/imageView>/.exec(storyboard)
  const logo = attrs(logoTag?.[0].split('>')[0] ?? '')
  const constraints = [...storyboard.matchAll(/<constraint\b[^>]*\/>/g)].map(m => attrs(m[0]))

  it('shows the LaunchLogo image, centred on the screen, 120pt square', () => {
    expect(logo.image).toBe('LaunchLogo')
    expect(logo.contentMode).toBe('scaleAspectFit')
    for (const axis of ['centerX', 'centerY']) {
      const pinned = constraints.filter(
        c =>
          c.firstAttribute === axis &&
          c.secondAttribute === axis &&
          [c.firstItem, c.secondItem].sort().join() === [logo.id, root.id].sort().join() &&
          !Number(c.constant ?? 0),
      )
      expect(pinned, axis).toHaveLength(1)
    }
    const own = [...logoTag![1].matchAll(/<constraint\b[^>]*\/>/g)].map(m => attrs(m[0]))
    expect(own.find(c => c.firstAttribute === 'width')?.constant).toBe('120')
    expect(own.find(c => c.firstAttribute === 'height')?.constant).toBe('120')
    expect(storyboard).toMatch(/<image name="LaunchLogo" width="120" height="120"\/>/)
  })

  it('holds no text: a launch screen is never localised, and the mark stands for the name', () => {
    expect(storyboard).not.toMatch(/<label\b|<textView\b|\btext="/)
  })

  it('paints the light ground the app starts in, the same colour every other ground starts from', () => {
    const background = attrs(/<color key="backgroundColor"[^>]*\/>/.exec(storyboard)![0])
    expect(ibColour(background)).toBe(THEME_GROUND.light)
    // drawn in the light appearance, whatever the phone is set to
    expect(attrs(/<device\b[^>]*\/>/.exec(storyboard)![0]).appearance).toBe('light')
    // the web view behind the page before it paints
    expect(/backgroundColor: '(#[0-9a-f]{6})'/.exec(read('capacitor.config.ts'))?.[1]).toBe(THEME_GROUND.light)
    // the installed web app's title bar and splash
    const vite = read('vite.config.ts')
    expect(/theme_color: '(#[0-9a-f]{6})'/.exec(vite)?.[1]).toBe(THEME_GROUND.light)
    expect(/background_color: '(#[0-9a-f]{6})'/.exec(vite)?.[1]).toBe(THEME_GROUND.light)
    // the browser's bar, until index.html's inline script says otherwise (theme.test.ts)
    expect(/<meta name="theme-color" content="(#[0-9a-f]{6})"/.exec(read('index.html'))?.[1]).toBe(THEME_GROUND.light)
  })

  it("gives SceneDelegate the same two grounds, for the privacy cover and the web view's overscroll", () => {
    const swift = read(`${APP}/SceneDelegate.swift`)
    const ground = (name: string) => {
      const m = new RegExp(`static let ${name} = UIColor\\(red: ([\\d.]+), green: ([\\d.]+), blue: ([\\d.]+), alpha: 1\\)`).exec(swift)
      return m && ibColour({ red: m[1], green: m[2], blue: m[3] })
    }
    expect(ground('light')).toBe(THEME_GROUND.light)
    expect(ground('dark')).toBe(THEME_GROUND.dark)
    // the cover takes the window's current style, and the window takes the
    // saved choice before the bridge (and so the web view) exists
    expect(swift).toMatch(/cover\.backgroundColor = Ground\.of\(window\.traitCollection\)/)
    expect(swift).toMatch(/overrideUserInterfaceStyle = AppearanceChoice\.saved\s+window\?\.rootViewController = DrafterBridgeViewController\(\)/)
  })
})

/*
 * Settings → Appearance reaches the shell through one plugin call:
 * syncNativeAppearance in src/native.ts calls Appearance.apply({ style }), and
 * AppearancePlugin in SceneDelegate.swift answers it. A name, method or key that
 * drifts on either side fails silently — the page still paints its own theme and
 * the call's error is swallowed by design — while the status bar, keyboard,
 * pickers and privacy cover stop following the choice. So the two sides are
 * held to each other here.
 */
describe('AppearancePlugin: the shell answers the call native.ts makes', () => {
  const swift = read(`${APP}/SceneDelegate.swift`)
  const native = read('src/native.ts')

  it('is registered under the name, method and key syncNativeAppearance calls', () => {
    const name = /registerPlugin<AppearancePlugin>\('(\w+)'\)/.exec(native)?.[1]
    const call = /appearancePlugin\.(\w+)\(\{ (\w+): pref \}\)/.exec(native)
    expect(name).toBe('Appearance')
    expect(call?.slice(1)).toEqual(['apply', 'style'])
    expect(native).toMatch(new RegExp(`${call![1]}\\(options: \\{ ${call![2]}: ThemePref \\}\\): Promise<void>`))
    expect(/public let jsName = "(\w+)"/.exec(swift)?.[1]).toBe(name)
    expect([...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map(m => m[1])).toEqual([call![1]])
    expect(swift).toMatch(new RegExp(`@objc func ${call![1]}\\(_ call: CAPPluginCall\\)`))
    expect(/call\.getString\("(\w+)"\)/.exec(swift)?.[1]).toBe(call![2])
    // the bridge registers the instance, or the call never arrives
    expect(swift).toMatch(/bridge\?\.registerPluginInstance\(AppearancePlugin\(\)\)/)
  })

  it('reads every choice Settings offers: Dark and Match system by name, Light as the default', () => {
    const style = /static func style\(_ raw: String\?\) -> UIUserInterfaceStyle \{([\s\S]*?)\n {4}\}/.exec(swift)?.[1] ?? ''
    const cases = Object.fromEntries([...style.matchAll(/case "(\w+)": return \.(\w+)/g)].map(m => [m[1], m[2]]))
    expect(cases).toEqual({ dark: 'dark', system: 'unspecified' })
    expect(style).toMatch(/default: return \.light/)
    expect([...THEME_PREFS].sort()).toEqual(['light', ...Object.keys(cases)].sort())
  })
})

describe('Info.plist: the app follows Settings → Appearance, not a forced style', () => {
  const plist = read(`${APP}/Info.plist`)
  /** The element after `<key>name</key>`: its tag, and its text when it has any. */
  const value = (key: string) => new RegExp(`<key>${key}</key>\\s*<(\\w+)\\s*/?>(?:([^<]*)</\\w+>)?`).exec(plist)

  it('forces no interface style, so the window can take the one the app chose', () => {
    expect(plist).not.toContain('UIUserInterfaceStyle')
  })

  it('lets the bridge set the status bar, in the default style that follows light and dark', () => {
    expect(value('UIViewControllerBasedStatusBarAppearance')?.[1]).toBe('true')
    expect(value('UIStatusBarStyle')?.[2]).toBe('UIStatusBarStyleDefault')
  })
})

describe('LaunchLogo artwork', () => {
  const set = JSON.parse(read(`${CATALOG}/LaunchLogo.imageset/Contents.json`)) as {
    images: { filename?: string; idiom: string; scale: string }[]
  }

  it('comes at 1x, 2x and 3x, each 120pt square', () => {
    expect(set.images.map(i => i.scale)).toEqual(['1x', '2x', '3x'])
    for (const image of set.images) {
      const png = readPng(path(`${CATALOG}/LaunchLogo.imageset/${image.filename}`))
      const side = 120 * Number.parseInt(image.scale)
      expect({ width: png.width, height: png.height }, image.scale).toEqual({ width: side, height: side })
    }
  })

  it("is the icon's plane alone, centred, on a transparent ground", () => {
    expect(planeFills).toHaveLength(2)
    for (const image of set.images) {
      const { width, height, pixel } = readPng(path(`${CATALOG}/LaunchLogo.imageset/${image.filename}`))
      for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
        expect(pixel(x, y)[3], `${image.scale} corner`).toBe(0)
      }
      const fills = new Map(planeFills.map(f => [f, 0]))
      const dark: string[] = []
      let [left, right, top, bottom] = [width, -1, height, -1]
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [r, g, b, a] = pixel(x, y)
          if (!a) continue
          left = Math.min(left, x)
          right = Math.max(right, x)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
          if (a < 255) continue
          // solid pixels are the plane's two oranges, or a blend where they
          // meet; the icon's dark ground would be solid with almost no red
          if (r < 0xe0) dark.push(`${hex([r, g, b])} at ${x},${y}`)
          const fill = planeFills.find(f => [r, g, b].every((v, i) => Math.abs(v - Number.parseInt(f.slice(1 + 2 * i, 3 + 2 * i), 16)) <= 2))
          if (fill) fills.set(fill, fills.get(fill)! + 1)
        }
      }
      expect(dark.slice(0, 3), image.scale).toEqual([])
      // both halves of the plane are drawn, not just one of them
      for (const [fill, count] of fills) expect(count / (width * height), `${image.scale} ${fill}`).toBeGreaterThan(0.05)
      // the image view centres the canvas, so the plane must sit in its middle
      expect(Math.abs(left + right + 1 - width) / 2, `${image.scale} x`).toBeLessThanOrEqual(image.scale === '1x' ? 1 : 1.5)
      expect(Math.abs(top + bottom + 1 - height) / 2, `${image.scale} y`).toBeLessThanOrEqual(image.scale === '1x' ? 1 : 1.5)
    }
  })
})

describe('Asset catalog', () => {
  it('holds every image a storyboard or Swift names, and none that nothing uses', () => {
    const sets = readdirSync(path(CATALOG))
      .filter(f => f.endsWith('.imageset'))
      .map(f => f.replace(/\.imageset$/, ''))
    const storyboards = readdirSync(path(`${APP}/Base.lproj`)).filter(f => f.endsWith('.storyboard'))
    const swift = readdirSync(path(APP)).filter(f => f.endsWith('.swift'))
    const named = new Set([
      ...storyboards.flatMap(f => [...read(`${APP}/Base.lproj/${f}`).matchAll(/\bimage="([^"]+)"/g)].map(m => m[1])),
      ...swift.flatMap(f => [...read(`${APP}/${f}`).matchAll(/UIImage\(named: "([^"]+)"/g)].map(m => m[1])),
    ])
    expect(sets.sort()).toEqual([...named].sort())
  })
})
