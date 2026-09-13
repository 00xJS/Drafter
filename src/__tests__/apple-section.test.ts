import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Everything that needs the paid Apple Developer Program sits in one place —
// Admin → Apple, and the README's "When you join" list — with the steps to build
// it, and the optional integrations read as optional rather than as faults.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const admin = read('../components/Admin.tsx')
const readme = read('../../README.md')
const aasa = JSON.parse(read('../../ios/apple-app-site-association.example.json'))

const section = (cls: string) => {
  const start = admin.indexOf(`className="settings-section ${cls}"`)
  return admin.slice(start, admin.indexOf('</section>', start))
}

describe('the paid Apple Developer Program in one place', () => {
  it('gives Admin one Apple section with every paid-only step and the live APNs status', () => {
    expect(admin).toMatch(/\{ key: 'apple', label: 'Apple' \}/)
    expect(admin).not.toContain('g-domains')
    const apple = section('g-apple')
    for (const s of ['Sign with the paid team', 'iOS push (APNs)', 'APNS_KEY_ID', 'aps-environment', 'Universal Links', 'applinks:drafterz.netlify.app', 'Password AutoFill', 'webcredentials:drafterz.netlify.app', 'TestFlight', 'widget']) {
      expect(apple, s).toContain(s)
    }
    expect(apple).toMatch(/<HealthCard title="iOS push \(APNs\)" piece=\{status\.apns\} optional \/>/)
    expect(section('g-integrations')).not.toContain('iOS push (APNs)')
  })

  it('reads the optional integrations as optional, with their setup folded away', () => {
    for (const title of ['Web push \\(VAPID\\)', 'Google Calendar', 'Outlook / Microsoft 365', 'GitHub', 'Digest email \\(Resend\\)']) {
      expect(admin).toMatch(new RegExp(`<HealthCard title="${title}" piece=\\{status\\.\\w+\\} optional`))
    }
    expect(admin).toContain("'Optional — off'")
    expect(admin).toContain('<summary>How to turn it on</summary>')
  })

  it('ships an AASA template for the app, on the root links only', () => {
    expect(aasa.applinks.details[0].appIDs).toEqual(['TEAMID.app.drafter.ios'])
    expect(aasa.applinks.details[0].components).toEqual([expect.objectContaining({ '/': '/' })])
    expect(aasa.webcredentials.apps).toEqual(['TEAMID.app.drafter.ios'])
  })

  it('keeps the same list in the README', () => {
    const list = readme.slice(readme.indexOf('### When you join the Apple Developer Program'))
    for (const s of ['APNS_KEY_ID', 'apple-app-site-association.example.json', 'webcredentials:drafterz.netlify.app', 'TestFlight']) expect(list, s).toContain(s)
  })
})
