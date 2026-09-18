import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Universal Links and Password AutoFill need three things to agree: the
// capability in the entitlements, an association file Apple can fetch as JSON
// from the site, and the same <team>.<bundle> in both. They arrived together
// with the Apple Developer Program membership; before it, a free personal team
// could not provision push at all and the entitlements file was empty on purpose.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const entitlements = read('../../ios/App/App/App.entitlements')
const vite = read('../../vite.config.ts')
const netlify = read('../../netlify.toml')

describe('the iOS entitlements', () => {
  it('asks for push, and for the domain the app is served from', () => {
    expect(entitlements).toContain('<key>aps-environment</key>')
    expect(entitlements).toContain('applinks:drafterz.netlify.app')
    expect(entitlements).toContain('webcredentials:drafterz.netlify.app')
  })

  it('uses the sandbox value, which Xcode rewrites when it archives', () => {
    // development is the APNs sandbox — what a build run from Xcode talks to.
    // Archiving for TestFlight/App Store rewrites it to production, so one
    // value is right for both and nothing has to be remembered at release.
    expect(entitlements).toMatch(/<key>aps-environment<\/key>\s*<string>development<\/string>/)
  })
})

describe('the association file', () => {
  it('is written from APPLE_TEAM_ID, and not written at all without one', () => {
    // a half-written association is worse than none: iOS caches what it
    // fetches, so a wrong appID silently stops links working
    expect(vite).toContain("const APPLE_TEAM_ID = (process.env.APPLE_TEAM_ID ?? '').trim()")
    expect(vite).toContain('if (!APPLE_TEAM_ID) return')
    expect(vite).toContain("fileName: '.well-known/apple-app-site-association'")
  })

  it('names the bundle the iOS project builds', () => {
    const pbx = read('../../ios/App/App.xcodeproj/project.pbxproj')
    expect(pbx).toContain('PRODUCT_BUNDLE_IDENTIFIER = app.drafter.ios;')
    expect(vite).toContain("process.env.APPLE_BUNDLE_ID ?? 'app.drafter.ios'")
  })

  it('is served as JSON, which Apple will not read it without', () => {
    const rule = netlify.slice(netlify.indexOf('/.well-known/apple-app-site-association'))
    expect(rule.slice(0, 200)).toContain('Content-Type = "application/json"')
  })
})
