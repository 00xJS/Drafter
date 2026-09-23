import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BackupList } from '../admin'
import { SnapshotFiles, readableName, type OpenedSnapshot, type SnapshotLink } from '../components/AdminBackups'

// Admin → Backups → Read it fetched the snapshot and opened the passphrase box
// after every account's list — nineteen rows below the button on a phone and
// below the fold on a computer — so the owner tapped it and saw nothing happen.
// What Read it and Download bring back now sits under the row that asked.

const OWNER = '907ec8ad-a40a-47c1-8a0f-16ff7243ba87'
const MEMBER = '5b0c2f1e-7d44-4c1b-9a53-2f4e8c1d6a70'
const path = (user: string, date: string) => `backups/${user}/${date}.json`
const file = (user: string, date: string) => ({ name: `${date}.json`, path: path(user, date), date, size: 120_000, updatedAt: null })

const USERS: BackupList['users'] = [
  { userId: MEMBER, email: 'member@example.com', bytes: 62_000, files: [file(MEMBER, '2026-09-23'), file(MEMBER, '2026-09-22')] },
  { userId: OWNER, email: 'owner@example.com', bytes: 360_000, files: [file(OWNER, '2026-09-23'), file(OWNER, '2026-09-22'), file(OWNER, '2026-09-21')] },
]

const ENVELOPE = { drafterBackup: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: 310_000, salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=', userId: OWNER }
const PLAIN = { exportedAt: '2026-09-20T09:00:00.000Z', userId: OWNER, items: [{ id: 't1' }, { id: 't2' }] }

function render(o: { opened?: OpenedSnapshot | null; link?: SnapshotLink | null; pending?: string; passphrase?: string } = {}) {
  const noop = () => {}
  return renderToStaticMarkup(
    <SnapshotFiles
      users={USERS}
      busy={!!o.pending}
      pending={o.pending ?? ''}
      opened={o.opened ?? null}
      link={o.link ?? null}
      passphrase={o.passphrase ?? ''}
      onPassphrase={noop}
      onRead={noop}
      onDownload={noop}
      onUnlock={noop}
      onSave={noop}
      onClose={noop}
    />,
  )
}

/** Each list item in the order drawn: a row by its account and date, or `panel` for what one brought back. */
function sequence(html: string): string[] {
  return html
    .split('<li')
    .slice(1)
    .map(li => {
      if (li.includes('class="backup-open"')) return 'panel'
      const date = /\d{4}-\d{2}-\d{2}/.exec(li)?.[0]
      return date ?? '?'
    })
}

describe('reading a snapshot in Admin → Backups', () => {
  it('opens the passphrase box directly under the row that was tapped, and nowhere else', () => {
    const html = render({ opened: { path: path(OWNER, '2026-09-22'), raw: ENVELOPE, snapshot: null } })
    // the member's two rows, then the owner's: the box follows the owner's 09-22 and precedes 09-21
    expect(sequence(html)).toEqual(['2026-09-23', '2026-09-22', '2026-09-23', '2026-09-22', 'panel', '2026-09-21'])
    expect(html.match(/placeholder="Backup passphrase"/g)).toHaveLength(1)
  })

  it('says why a snapshot could not be fetched, under its row, instead of below every list', () => {
    const html = render({ opened: { path: path(MEMBER, '2026-09-23'), raw: null, snapshot: null, error: 'The snapshot could not be fetched (400). Try again.' } })
    expect(sequence(html).slice(0, 3)).toEqual(['2026-09-23', 'panel', '2026-09-22'])
    expect(html).toContain('could not be fetched (400)')
    expect(html).toContain('Try again')
    // nothing to type a passphrase into when there is no file
    expect(html).not.toContain('Backup passphrase')
  })

  it('tells an opened snapshot from one that never needed a passphrase', () => {
    const decrypted = render({ opened: { path: path(OWNER, '2026-09-21'), raw: ENVELOPE, snapshot: PLAIN } })
    expect(decrypted).toContain('2 records')
    expect(decrypted).toContain('Decrypted here, in this browser')
    expect(decrypted).toContain('Save the readable copy')
    expect(sequence(decrypted).slice(-2)).toEqual(['2026-09-21', 'panel'])

    const plain = render({ opened: { path: path(OWNER, '2026-09-21'), raw: PLAIN, snapshot: PLAIN } })
    expect(plain).toContain('needed no passphrase')
    expect(plain).not.toContain('Decrypted here')
  })

  it('keeps a wrong passphrase’s answer beside the box it was typed into', () => {
    const html = render({ opened: { path: path(OWNER, '2026-09-23'), raw: ENVELOPE, snapshot: null, error: 'That passphrase does not open this snapshot.' } })
    const panel = html.slice(html.indexOf('class="backup-open"'))
    expect(panel.indexOf('does not open this snapshot')).toBeGreaterThan(panel.indexOf('Backup passphrase'))
    expect(panel.indexOf('does not open this snapshot')).toBeLessThan(panel.indexOf('2026-09-22'))
  })

  it('puts a download link under its own row too', () => {
    const html = render({ link: { path: path(MEMBER, '2026-09-22'), url: 'https://example.supabase.co/storage/v1/object/sign/media/x?token=t' } })
    expect(sequence(html).slice(0, 3)).toEqual(['2026-09-23', '2026-09-22', 'panel'])
    expect(html).toContain('token=t')
    const failed = render({ link: { path: path(MEMBER, '2026-09-22'), url: '', error: 'Not allowed' } })
    expect(failed).toContain('Not allowed')
    expect(failed).not.toContain('Download link')
  })

  it('says Fetching… on the one button that is fetching', () => {
    const reading = render({ pending: `read:${path(OWNER, '2026-09-22')}` })
    expect(reading.match(/Fetching…/g)).toHaveLength(1)
    const row = reading.split('<li').find(li => li.includes('Fetching…'))!
    expect(row).toContain('2026-09-22')
    expect(row.indexOf('Fetching…')).toBeLessThan(row.indexOf('Download'))

    const linking = render({ pending: `link:${path(OWNER, '2026-09-22')}` })
    const linkRow = linking.split('<li').find(li => li.includes('Fetching…'))!
    expect(linkRow).toContain('Read it')
    expect(linkRow.indexOf('Fetching…')).toBeGreaterThan(linkRow.indexOf('Read it'))
  })
})

describe('what Save the readable copy calls the file', () => {
  it('says whose snapshot it is, so two accounts’ copies of one night are told apart', () => {
    const owner = readableName(path(OWNER, '2026-09-22'), 'owner@example.com')
    const member = readableName(path(MEMBER, '2026-09-22'), 'member@example.com')
    expect(owner).toBe('2026-09-22-owner-readable.json')
    expect(member).toBe('2026-09-22-member-readable.json')
    expect(owner).not.toBe(member)
  })

  it('keeps the name to what a file name can hold', () => {
    expect(readableName(path(OWNER, '2026-09-22'), 'Joseph.S+drafter@live.com')).toBe('2026-09-22-joseph.s-drafter-readable.json')
  })

  it('names an account with no email by the start of its id', () => {
    expect(readableName(path(MEMBER, '2026-09-21'), null)).toBe('2026-09-21-5b0c2f1e-readable.json')
    expect(readableName(path(MEMBER, '2026-09-21'), '')).toBe('2026-09-21-5b0c2f1e-readable.json')
  })
})
