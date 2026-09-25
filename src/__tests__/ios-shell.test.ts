import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The iOS shell's own settings, read as data: what Info.plist lets the app do.
// None of it runs in node, and a wrong value fails nothing in the build — an
// iPhone just turns sideways, or opens on a second copy of the bridge — so the
// values are held here.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8')
const plist = read('ios/App/App/Info.plist')

/** The strings of an array key in the plist, in order. Null when the key is not there. */
function strings(key: string): string[] | null {
  const body = new RegExp(`<key>${key.replace(/[~.]/g, '\\$&')}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(plist)?.[1]
  return body === undefined ? null : [...body.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1])
}

describe('orientation', () => {
  it('holds an iPhone upright: sideways it got the desktop layout, 36px controls and a sliver above the keyboard', () => {
    expect(strings('UISupportedInterfaceOrientations')).toEqual(['UIInterfaceOrientationPortrait'])
  })

  it('leaves an iPad every way round, as Split View and Stage Manager need', () => {
    expect(strings('UISupportedInterfaceOrientations~ipad')?.sort()).toEqual(
      ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight', 'UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'].sort(),
    )
  })

  it('is read by the bridge from the same key, so the web view never turns on its own', () => {
    // CAPBridgeViewController.setScreenOrientationDefaults builds
    // supportedInterfaceOrientations from this key (iOS hands an iPad its ~ipad copy)
    const bridge = read('node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgeViewController.swift')
    expect(bridge).toMatch(/plist\["UISupportedInterfaceOrientations"\] as\? \[String\]/)
    expect(read('ios/App/App/SceneDelegate.swift')).not.toMatch(/supportedInterfaceOrientations/)
  })
})
