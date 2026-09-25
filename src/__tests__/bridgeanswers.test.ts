import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

/*
 * iOS 27's WebKit holds every JavaScript alert, confirm and prompt until the
 * page's Safe Browsing lookup answers, with no timeout, and Capacitor's
 * native-bridge.js asks two questions through a synchronous prompt() at
 * document start: a lookup of capacitor://drafter that never answered left the
 * app blank until it was force-quit. The shell turns Safe Browsing off for its
 * web view and answers the two questions in the page first
 * (ios/App/App/SceneDelegate.swift: DrafterBridgeViewController, BridgeAnswers).
 * These hold that script to the bridge it stands in front of, and the bridge
 * read here to the framework the app links.
 */

const path = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const read = (rel: string) => readFileSync(path(rel), 'utf8')
const swift = read('ios/App/App/SceneDelegate.swift')
const bridge = read('node_modules/@capacitor/ios/Capacitor/Capacitor/assets/native-bridge.js')

/** BridgeAnswers.source as Swift's multi-line literal makes it: the closing delimiter's indentation off every line. */
function source(): string {
  const m = /static let source = """\n([\s\S]*?)\n( *)"""/.exec(swift)
  if (!m) throw new Error('BridgeAnswers.source was not found in SceneDelegate.swift')
  const indent = m[2].length
  return m[1]
    .split('\n')
    .map(line => line.slice(indent))
    .join('\n')
}

/** BridgeAnswers.script(cookies:http:) */
const script = (cookies: boolean, http: boolean) => source().replace('__COOKIES__', String(cookies)).replace('__HTTP__', String(http))

/** A page with the script run in it, and the prompt it replaced. */
function page(cookies = false, http = false) {
  const native = vi.fn((message?: string) => `native: ${message}`)
  const window: Record<string, unknown> = { prompt: native }
  window.window = window
  runInNewContext(script(cookies, http), window)
  const prompt = (message: string) => (window.prompt as (m: string) => string)(message)
  return { window, native, prompt }
}

const ask = (type: string) => JSON.stringify({ type })

describe('the bridge asks, at document start, the two questions the page answers', () => {
  it('asks whether CapacitorCookies and CapacitorHttp are on through prompt(), and patches only on "true"', () => {
    expect(bridge).toMatch(/type: 'CapacitorCookies\.isEnabled',\s*\};\s*const (\w+) = prompt\(JSON\.stringify\(payload\)\);\s*if \(\1 === 'true'\)/)
    expect(bridge).toMatch(/type: 'CapacitorHttp',\s*\};\s*const (\w+) = prompt\(JSON\.stringify\(payload\)\);\s*if \(\1 === 'true'\)/)
  })

  it('is the bridge inside the framework the app links: the Swift package pins the version node_modules holds', () => {
    const pinned = /capacitor-swift-pm\.git", exact: "([^"]+)"/.exec(read('ios/App/CapApp-SPM/Package.swift'))?.[1]
    const installed = (JSON.parse(read('node_modules/@capacitor/ios/package.json')) as { version: string }).version
    expect(pinned).toBe(installed)
  })
})

describe('BridgeAnswers answers them in the page', () => {
  it('as the config says, without the native prompt, then gives the page its prompt back', () => {
    const { window, native, prompt } = page(false, false)
    expect(prompt(ask('CapacitorCookies.isEnabled'))).toBe('false')
    expect(prompt(ask('CapacitorHttp'))).toBe('false')
    expect(native).not.toHaveBeenCalled()
    // both answered: the page's own prompt is the native one again
    expect(window.prompt).toBe(native)
  })

  it('says "true" for a plugin the config turns on', () => {
    expect(page(true, false).prompt(ask('CapacitorCookies.isEnabled'))).toBe('true')
    expect(page(false, true).prompt(ask('CapacitorHttp'))).toBe('true')
  })

  it('passes any other prompt through to the native one, while it waits for the two', () => {
    const { native, prompt } = page()
    expect(prompt('Name this link')).toBe('native: Name this link')
    expect(prompt(ask('CapacitorCookies.get'))).toBe(`native: ${ask('CapacitorCookies.get')}`)
    expect(native).toHaveBeenCalledTimes(2)
  })
})

describe('the shell turns Safe Browsing off and adds the answers where they survive', () => {
  it('reads each answer the way Capacitor’s own handler does', () => {
    expect(swift).toContain('getPluginConfig("CapacitorCookies").getBoolean("enabled", false)')
    expect(swift).toContain('getPluginConfig("CapacitorHttp").getBoolean("enabled", false)')
  })

  it('turns off the Safe Browsing lookup the dialogs wait on', () => {
    expect(swift).toContain('configuration.preferences.isFraudulentWebsiteWarningEnabled = false')
  })

  it('adds the script at document start in webView(with:configuration:), after Capacitor swaps its content controller in', () => {
    expect(swift).toMatch(/injectionTime: \.atDocumentStart, forMainFrameOnly: true/)
    const hook = /override func webView\(with frame: CGRect, configuration: WKWebViewConfiguration\) -> WKWebView \{([\s\S]*?)\n {4}\}/.exec(swift)?.[1] ?? ''
    expect(hook).toContain('configuration.userContentController.addUserScript(script)')
    const setup = /override func webViewConfiguration\(for instanceConfiguration: InstanceConfiguration\) -> WKWebViewConfiguration \{([\s\S]*?)\n {4}\}/.exec(swift)?.[1] ?? ''
    expect(setup).not.toContain('addUserScript')
  })
})
