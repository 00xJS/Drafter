import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Universal Links and Password AutoFill need three things to agree: the
// capability in the entitlements, an association file Apple can fetch as JSON
// from the site, and the same <team>.<bundle> in both. They arrived together
// with the Apple Developer Program membership; before it, a free personal team
// could not provision push at all and the entitlements file was empty on purpose.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
// The file Xcode signs, and the one waiting for the membership to clear. A
// free personal team cannot provision push or associated domains — asking for
// either fails the build — so the live file stays empty until then and
// `npm run ios:apple` swaps the paid one in.
const entitlements = read('../../ios/App/App/App.paid.entitlements')
const live = read('../../ios/App/App/App.entitlements')
const pkg = JSON.parse(read('../../package.json')) as { scripts: Record<string, string> }
const vite = read('../../vite.config.ts')
const netlify = read('../../netlify.toml')

describe('the iOS entitlements', () => {
  it('is one of the two known states, never something hand-edited', () => {
    // The file Xcode signs is either empty (a free personal team, which cannot
    // provision push or associated domains — asking fails the build) or exactly
    // the paid one, put there by `npm run ios:apple`. Anything else is a third
    // state nobody chose, and the failure it causes arrives at archive time.
    const paid = live.trim() === entitlements.trim()
    const free = !live.includes('aps-environment') && !live.includes('associated-domains')
    expect(paid || free, paid ? '' : 'App.entitlements is neither empty nor the paid file').toBe(true)
    expect(pkg.scripts['ios:apple']).toContain('App.paid.entitlements')
  })

  it('can be put back for a free team, which is what a lapsed membership needs', () => {
    // `git checkout ios/App/App/App.entitlements` is the way back, so the empty
    // version has to stay in git rather than being generated
    expect(pkg.scripts['ios:apple']).toMatch(/^cp ios\/App\/App\/App\.paid\.entitlements ios\/App\/App\/App\.entitlements/)
  })

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
    const header = netlify.slice(netlify.indexOf('[[headers]]', netlify.indexOf('for = "/.well-known/apple-app-site-association"') - 40))
    expect(header.slice(0, 220)).toContain('Content-Type = "application/json"')
  })

  it('is allowed to appear in the build, because the team id is not a secret', () => {
    // Netlify's scanner fails a build when an environment variable's value
    // turns up in what was published. This one does by design — it is half of
    // the appID Apple fetches — and the same ten characters are printed by
    // `codesign -dv` on any copy of the app. It names an account; it authorises
    // nothing.
    expect(netlify).toContain('SECRETS_SCAN_OMIT_KEYS = "APPLE_TEAM_ID"')
    // the whole scanner stays on: this is one key, not a blanket disable
    expect(netlify).not.toContain('SECRETS_SCAN_ENABLED = "false"')
  })

  it('404s when it has not been written, rather than answering with the app page', () => {
    // The catch-all turns any unknown path into index.html, and the header rule
    // above would then label that HTML application/json — so Apple fetched a
    // valid-looking document that was not the association, and cached the
    // failure. Worse than a 404, which is the honest answer.
    const redirect = netlify.slice(netlify.indexOf('from = "/.well-known/apple-app-site-association"'))
    expect(redirect.slice(0, 120)).toContain('status = 404')
    // and it must come BEFORE the catch-all, or the catch-all wins
    expect(netlify.indexOf('from = "/.well-known/apple-app-site-association"')).toBeLessThan(netlify.indexOf('from = "/*"'))
  })
})

describe('the release script', () => {
  const pbx = read('../../ios/App/App.xcodeproj/project.pbxproj')

  it('raises the build number before building, not after', () => {
    // App Store Connect refuses a build number it has already seen, and refuses
    // it AFTER the archive, export and upload have run — minutes spent to be
    // told to change one integer
    expect(pkg.scripts['release:ios']).toMatch(/^node scripts\/ios-build-number\.mjs && npm run build:ios/)
  })

  it('moves every configuration together', () => {
    // Debug and Release drifting apart is how you upload a build whose number
    // is not the one you just raised
    const numbers = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(m => m[1])
    expect(numbers.length).toBeGreaterThan(1)
    expect(new Set(numbers).size).toBe(1)
  })

  it('leaves the version people read alone', () => {
    const bump = read('../../scripts/ios-build-number.mjs')
    expect(bump).not.toMatch(/writeFileSync[\s\S]*MARKETING_VERSION = \$/)
    expect(pbx).toContain('MARKETING_VERSION = 1.0;')
  })

  // Xcode Cloud never runs `npm run release:ios`, so without these it would
  // archive whatever build number happens to be committed — and App Store
  // Connect refuses a number it has already seen for this MARKETING_VERSION,
  // after the archive, the export and the upload have all run.
  it('gives Xcode Cloud the two scripts it needs, both executable', () => {
    for (const name of ['ci_post_clone.sh', 'ci_pre_xcodebuild.sh']) {
      const mode = execFileSync('git', ['ls-files', '-s', `ci_scripts/${name}`], { cwd: ROOT, encoding: 'utf8' })
      expect(mode, `${name} is not tracked`).not.toBe('')
      // Xcode Cloud skips a script that is not executable, silently
      expect(mode.startsWith('100755'), `${name} is committed without the executable bit`).toBe(true)
    }
  })

  it('builds the web bundle in the cloud, because the target’s inputs are generated and gitignored', () => {
    const post = read('../../ci_scripts/ci_post_clone.sh')
    expect(post).toContain('npm ci')
    expect(post).toContain('npm run build:ios')
    // the three Resources inputs ios/.gitignore keeps out of the repo
    const ignore = read('../../ios/.gitignore')
    for (const input of ['App/App/public', 'App/App/capacitor.config.json', 'App/App/config.xml']) {
      expect(ignore, `${input} is no longer ignored — is this script still needed?`).toContain(input)
    }
    expect(post).toContain('ios/App/App/public/index.html')
  })

  it('takes the build number from the cloud’s own counter, and leaves it alone without one', () => {
    const pre = read('../../ci_scripts/ci_pre_xcodebuild.sh')
    expect(pre).toContain('CI_BUILD_NUMBER')
    expect(pre).toMatch(/ios-build-number\.mjs --set/)
    const bump = read('../../scripts/ios-build-number.mjs')
    expect(bump, 'the script has no --set to give it').toContain('--set')
  })
})
