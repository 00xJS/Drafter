import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Apple signing is done. Admin no longer walks through the paid-team
// checklist; iOS push health sits with the other host integrations.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const admin = read('../components/Admin.tsx')
const readme = read('../../README.md')
const aasa = JSON.parse(read('../../ios/apple-app-site-association.example.json'))

const section = (cls: string) => {
  const start = admin.indexOf(`className="settings-section ${cls}`)
  return admin.slice(start, admin.indexOf('</section>', start))
}

describe('Apple is signed; Admin no longer has a setup tab for it', () => {
  it('drops the Apple group and keeps APNs health with the other integrations', () => {
    expect(admin).not.toMatch(/\{ key: 'apple', label: 'Apple' \}/)
    expect(admin).not.toContain('g-apple')
    expect(admin).not.toContain('apple-steps')
    // Integration health lost its tab in v3.25 and folds away inside Data;
    // every read-out it had is still there, under the same HealthCards.
    expect(admin).not.toMatch(/\{ key: 'integrations', label: 'Integrations' \}/)
    const health = section('g-data admin-integrations')
    expect(health).toContain('Integration health')
    expect(health).toContain('iOS push (APNs)')
    expect(health).toMatch(/<HealthCard title="iOS push \(APNs\)" piece=\{status\.apns\} optional/)
  })

  it('reads the optional integrations as optional, with their setup folded away', () => {
    for (const title of ['iOS push \\(APNs\\)', 'Web push \\(VAPID\\)', 'Google Calendar', 'Outlook / Microsoft 365', 'GitHub', 'Digest email \\(Resend\\)']) {
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

  it('keeps the iPhone list in the README, not in Admin', () => {
    const list = readme.slice(readme.indexOf('### iPhone and the Apple Developer Program'))
    for (const s of ['APNS_KEY_ID', 'apple-app-site-association.example.json', 'webcredentials:drafterz.netlify.app', 'TestFlight']) expect(list, s).toContain(s)
    expect(list).toContain('Admin → Integrations')
    expect(list).not.toContain('Admin → Apple')
  })
})
