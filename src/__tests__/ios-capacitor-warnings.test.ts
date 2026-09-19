import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

/**
 * Xcode's five recurring warnings. SceneDelegate is ours; Keyboard and App
 * are Capacitor, patched after install so a clean npm ci still builds quiet.
 */
describe('the Xcode warnings Capacitor leaves on an archive', () => {
  it('does not capture a mutating observer token in SceneDelegate', () => {
    const swift = read('../../ios/App/App/SceneDelegate.swift')
    expect(swift).toContain('#selector(handleBridgeViewDidAppear)')
    expect(swift).not.toMatch(/var token: NSObjectProtocol\?/)
  })

  it('tells clang that KeyboardPlugin’s CAP_PLUGIN macro is the protocol', () => {
    const src = read('../../node_modules/@capacitor/keyboard/ios/Sources/KeyboardPlugin/Keyboard.m')
    expect(src).toContain('-Wobjc-protocol-property-synthesis')
  })

  it('gives AppPlugin a real string for the preferred language', () => {
    const src = read('../../node_modules/@capacitor/app/ios/Sources/AppPlugin/AppPlugin.swift')
    expect(src).toContain('Bundle.main.preferredLocalizations.first ?? ""')
  })
})
