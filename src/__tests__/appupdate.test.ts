import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { busy, pageBuild, readTried, updateStep } from '../appupdate'

// A refresh or a return to the app lands on the newest deploy: pages come from
// the network first, the worker is re-checked, the page's build is compared
// with /version.json, and a stale copy no new worker replaces is cleared the
// way "clear site data" would.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

describe('the build a page was loaded from', () => {
  it('is the stamp in index.html, or dev without one', () => {
    const doc = (content: string | null) =>
      ({ querySelector: (sel: string) => (sel === 'meta[name="drafter-build"]' && content !== null ? { content } : null) }) as unknown as Pick<Document, 'querySelector'>
    expect(pageBuild(doc('abc123'))).toBe('abc123')
    expect(pageBuild(doc(null))).toBe('dev')
    expect(pageBuild(doc(''))).toBe('dev')
  })
})

describe('the next step towards the newest deploy', () => {
  it('does nothing when the builds match or the server cannot be asked', () => {
    expect(updateStep('abc', 'abc', 'none')).toBe('current')
    expect(updateStep('abc', null, 'update')).toBe('current')
  })

  it('gives a newer build the chance to arrive as a worker, then clears the cache, then stops', () => {
    expect(updateStep('abc', 'def', 'none')).toBe('wait')
    expect(updateStep('abc', 'def', 'update')).toBe('reset')
    expect(updateStep('abc', 'def', 'reset')).toBe('give-up')
  })

  it('remembers what it tried for one build only, so the next deploy starts again', () => {
    const store = (v: unknown) => ({ getItem: () => JSON.stringify(v) })
    expect(readTried('def', store({ build: 'def', tried: 'update' }))).toBe('update')
    expect(readTried('ghi', store({ build: 'def', tried: 'reset' }))).toBe('none')
    expect(readTried('def', { getItem: () => 'not json' })).toBe('none')
    expect(readTried('def', null)).toBe('none')
  })
})

describe('never reloading under an edit', () => {
  const doc = (dialog: boolean, active: Partial<HTMLElement> | null) =>
    ({ querySelector: (sel: string) => (sel.includes('dialog') && dialog ? {} : null), activeElement: active }) as unknown as Pick<Document, 'querySelector' | 'activeElement'>

  it('is busy while a dialog is open or a field has the cursor', () => {
    expect(busy(doc(true, null))).toBe(true)
    expect(busy(doc(false, { tagName: 'TEXTAREA', isContentEditable: false }))).toBe(true)
    expect(busy(doc(false, { tagName: 'DIV', isContentEditable: true }))).toBe(true)
    expect(busy(doc(false, { tagName: 'BUTTON', isContentEditable: false }))).toBe(false)
    expect(busy(doc(false, null))).toBe(false)
  })
})

describe('wired into the build and the host', () => {
  const vite = read('../../vite.config.ts')
  const main = read('../main.tsx')
  const netlify = read('../../netlify.toml')
  const appupdate = read('../appupdate.ts')
  const precache = read('../../scripts/check-precache.mjs')

  it('stamps each build into index.html and /version.json, and the build checks they agree', () => {
    expect(vite).toMatch(/const BUILD_ID = process\.env\.DEPLOY_ID \|\| process\.env\.COMMIT_REF \|\|/)
    expect(vite).toMatch(/attrs: \{ name: 'drafter-build', content: BUILD_ID \}/)
    expect(vite).toMatch(/fileName: 'version\.json'/)
    expect(vite).toMatch(/buildStamp\(\),\s*VitePWA\(/)
    expect(precache).toMatch(/dist\/version\.json is missing/)
    expect(precache).toMatch(/does not match/)
  })

  it('serves pages from the network first, with the saved copy offline', () => {
    expect(vite).toMatch(/navigateFallback: null/)
    // without this the precache answers "/" from its own copy, cache-first
    expect(vite).toMatch(/directoryIndex: null/)
    expect(vite).toMatch(/handler: 'NetworkFirst'/)
    expect(vite).toMatch(/precacheFallback: \{ fallbackURL: 'index\.html' \}/)
    // the OAuth metadata and endpoints are functions, never the app shell
    expect(vite).toMatch(/request\.mode === 'navigate' && !\/\^\\\/\(api\\\/\|\\\.well-known\\\/\|oauth\\\/\(register\|token\|revoke\)\$\)\/\.test\(url\.pathname\)/)
  })

  it('lets a new worker take over at once, registered by the app rather than the plugin', () => {
    expect(vite).toMatch(/injectRegister: false/)
    expect(vite).toMatch(/skipWaiting: true/)
    expect(vite).toMatch(/clientsClaim: true/)
    expect(main).not.toMatch(/virtual:pwa-register|registerSW\(/)
    expect(main).toMatch(/if \(!Capacitor\.isNativePlatform\(\) && import\.meta\.env\.PROD\) startAppUpdates\(\)/)
    expect(appupdate).toMatch(/updateViaCache: 'none'/)
  })

  it('has the host re-check the app page, the worker and the stamp on every load', () => {
    for (const path of ['/', '/index.html', '/sw.js', '/sw-push.js', '/manifest.webmanifest']) {
      expect(netlify).toMatch(new RegExp(`for = "${path.replace(/[.*]/g, '\\$&')}"\\s*\\[headers\\.values\\]\\s*Cache-Control = "no-cache"`))
    }
    expect(netlify).toMatch(/for = "\/version\.json"\s*\[headers\.values\]\s*Cache-Control = "no-store"/)
    expect(netlify).toMatch(/for = "\/assets\/\*"\s*\[headers\.values\]\s*Cache-Control = "public, max-age=31536000, immutable"/)
  })
})
