import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AdminStatus, AdminUser, BackupList, DataStats, SyncCheck } from '../admin'
import { Admin } from '../components/Admin'

// Admin said every failure — Back up now, Create, Send reset email, Link only,
// Disable, Delete, the sync check and the Test buttons — in one line after the
// last section, a scroll away from whichever button had been pressed. Each
// failure is now kept by the action's name, as `pending` already was, and
// said directly under its own button.

const OWNER = '907ec8ad-a40a-47c1-8a0f-16ff7243ba87'
const MEMBER = '5b0c2f1e-7d44-4c1b-9a53-2f4e8c1d6a70'
const user = (id: string, email: string): AdminUser => ({ id, email, createdAt: null, lastSignInAt: null, confirmedAt: null, disabled: false, bannedUntil: null })
const USERS = [user(OWNER, 'owner@example.com'), user(MEMBER, 'member@example.com')]

const piece = { configured: true, missing: [] }
const STATUS: AdminStatus = { google: piece, microsoft: piece, vapid: piece, apns: piece, ai: { ...piece, nvidia: true, nvidiaKeys: 1 }, github: piece, resend: piece, owner: { configured: true, email: 'owner@example.com' } }
const CHECK: SyncCheck = { sentence: 'The server accepted a test write for all 22 kinds, 1 hour ago.', record: null }
const STATS: DataStats & { syncCheck?: SyncCheck } = {
  total: 10,
  live: 9,
  tombstones: 1,
  purged: 0,
  unowned: 0,
  kinds: { task: 9 },
  newestSyncedAt: null,
  users: [],
  historyRows: 3,
  households: 1,
  householdMembers: 2,
  syncCheck: CHECK,
}
const BACKUPS: BackupList = {
  users: [{ userId: OWNER, email: 'owner@example.com', bytes: 1200, files: [{ name: '2026-09-22.json', path: `backups/${OWNER}/2026-09-22.json`, date: '2026-09-22', size: 1200, updatedAt: null }] }],
  totalFiles: 1,
  totalBytes: 1200,
  lastBackupAt: '2026-09-22T10:00:00.000Z',
  keep: 14,
}

const render = (failed: Record<string, string>, group: 'users' | 'data' | 'backups' = 'users') =>
  renderToStaticMarkup(<Admin initialGroup={group} initial={{ users: USERS, ownerEmail: 'owner@example.com', status: STATUS, stats: STATS, backups: BACKUPS, failed }} />)

const ALERT = /<(?:p|li) class="warn" role="alert">([^<]*)</

/** The one failure said on the page, and the markup on either side of it. */
function failure(html: string) {
  const all = [...html.matchAll(new RegExp(ALERT.source, 'g'))]
  expect(all).toHaveLength(1)
  const at = all[0].index
  return { text: all[0][1], before: html.slice(0, at), after: html.slice(at) }
}

/** True when `a` comes before `b` in `html`, and both are there. */
const inOrder = (html: string, ...needles: string[]) => {
  const at = needles.map(n => html.indexOf(n))
  return at.every(i => i > -1) && at.every((v, i) => i === 0 || at[i - 1] < v)
}

describe('an Admin action that fails says why under its own button', () => {
  it('Create: under the Add someone row, before the invite', () => {
    const { text, before, after } = failure(render({ create: 'That email already has an account.' }))
    expect(text).toBe('That email already has an account.')
    expect(before.trimEnd()).toMatch(/>Create<\/button><\/div>$/)
    expect(after).toContain('Invite them instead')
  })

  it('Send reset email and Link only: under the reset row, before Set a password myself', () => {
    for (const name of ['sendReset', 'linkOnly']) {
      const { before, after } = failure(render({ [name]: 'Supabase refused: rate limited.' }))
      expect(before).toMatch(/>Link only<\/button><\/div>$/)
      expect(after).toContain('Set a password myself')
    }
  })

  it('Disable and Delete: under that account’s row, and no other', () => {
    const html = render({ [`delete:${MEMBER}`]: 'They still own the household.' })
    const { before, after } = failure(html)
    // the member's row closes just before it; the owner's row came earlier
    expect(before).toMatch(/member@example\.com[\s\S]*<\/li>$/)
    expect(inOrder(before, 'owner@example.com', 'member@example.com')).toBe(true)
    expect(after.indexOf('</ul>')).toBeGreaterThan(-1)
    const disabled = failure(render({ [`disable:${OWNER}`]: 'Not allowed.' }))
    expect(disabled.before).toMatch(/owner@example\.com[\s\S]*<\/li>$/)
    expect(disabled.after).toContain('member@example.com')
  })

  it('Check now: inside the sync check card, under its button', () => {
    const { before, after } = failure(render({ syncCheck: 'The canary could not run.' }, 'data'))
    expect(before).toMatch(/>Check now<\/button><\/div>$/)
    expect(after).toMatch(/^[^]*?rolls it back, so nothing is kept/)
  })

  it('Back up now: under the button, before the list of snapshots', () => {
    const { before, after } = failure(render({ runBackup: 'Storage answered 503.' }, 'backups'))
    expect(before).toMatch(/>Back up now<\/button><\/div>$/)
    expect(after).toContain('2026-09-22')
  })

  it('the Test buttons: each under its own', () => {
    const cases: [string, string][] = [
      ['testPush', '>Send test push</button></div>'],
      ['testAi', '>Test AI</button></div>'],
      ['chatCheck', '>Check the assistant</button></div>'],
      ['previewDigest', '>Preview my digest</button></div>'],
    ]
    for (const [name, button] of cases) {
      const { before } = failure(render({ [name]: 'The host did not answer.' }, 'data'))
      expect(before.endsWith(button), name).toBe(true)
    }
  })

  it('says nothing anywhere when nothing has failed, and nothing after the last section', () => {
    const html = render({})
    expect(html).not.toMatch(ALERT)
    expect(html).toMatch(/<\/section><\/div>$/)
  })
})
