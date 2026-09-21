import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ENVELOPE_VERSION, backupEncryptionOn, isEnvelope, wrapSnapshot } from '../../netlify/functions/lib/backupcrypto.mjs'
import { buildSnapshot } from '../../netlify/functions/lib/backup.mjs'
import { CannotDecrypt, unwrapSnapshot } from '../backupcrypto'

// A snapshot holds everything one account has, journal included, and a private
// bucket is access control rather than encryption: the service key, the
// Supabase dashboard or Admin in this app could each sign a link and read the
// lot. v3.25 encrypts the body with a passphrase the host holds and the server
// never decrypts with.
//
// The two halves are in different runtimes — node writes them, the browser
// reads them — so this is the one place that runs both and proves a file
// written by one opens in the other.

// vitest's environment has no global crypto.subtle in node; the browser half
// uses the same WebCrypto API, so handing it node's is an honest stand-in
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

const PASSPHRASE = 'correct horse battery staple'
const ROWS = [
  { user_id: 'u1', data: { kind: 'journal', id: 'journal~2026-09-20', date: '2026-09-20', body: 'the private bit', updatedAt: '2026-09-20T00:00:00.000Z' } },
  { user_id: 'u1', data: { kind: 'task', id: 't1', title: 'Book the electrician', status: 'todo', updatedAt: '2026-09-20T00:00:00.000Z' } },
]

afterEach(() => {
  delete process.env.BACKUP_PASSPHRASE
})

describe('a snapshot written with a passphrase', () => {
  it('says the host encrypts once the variable is set, and not before', () => {
    expect(backupEncryptionOn()).toBe(false)
    process.env.BACKUP_PASSPHRASE = PASSPHRASE
    expect(backupEncryptionOn()).toBe(true)
    // whitespace is not a passphrase
    process.env.BACKUP_PASSPHRASE = '   '
    expect(backupEncryptionOn()).toBe(false)
  })

  it('keeps no readable trace of what is inside it', async () => {
    process.env.BACKUP_PASSPHRASE = PASSPHRASE
    const { body, encrypted } = await wrapSnapshot(buildSnapshot('u1', ROWS))
    expect(encrypted).toBe(true)
    expect(body).not.toContain('the private bit')
    expect(body).not.toContain('Book the electrician')
    expect(body).not.toContain(PASSPHRASE)
    const envelope = JSON.parse(body)
    expect(isEnvelope(envelope)).toBe(true)
    expect(envelope.drafterBackup).toBe(ENVELOPE_VERSION)
    // the account and the date stay readable: the path already says both, and
    // Admin has to list snapshots without the passphrase
    expect(envelope.userId).toBe('u1')
    expect(typeof envelope.exportedAt).toBe('string')
  })

  it('is different every night, even for the same records', async () => {
    process.env.BACKUP_PASSPHRASE = PASSPHRASE
    const at = new Date('2026-09-20T03:00:00.000Z')
    const a = JSON.parse((await wrapSnapshot(buildSnapshot('u1', ROWS, at))).body)
    const b = JSON.parse((await wrapSnapshot(buildSnapshot('u1', ROWS, at))).body)
    expect(a.salt).not.toBe(b.salt)
    expect(a.ct).not.toBe(b.ct)
  })

  it('opens in the browser with the passphrase, and gives back exactly what went in', async () => {
    process.env.BACKUP_PASSPHRASE = PASSPHRASE
    const snapshot = buildSnapshot('u1', ROWS)
    const { body } = await wrapSnapshot(snapshot)
    await expect(unwrapSnapshot(JSON.parse(body), PASSPHRASE)).resolves.toEqual(snapshot)
  })

  it('refuses the wrong passphrase rather than returning rubbish', async () => {
    process.env.BACKUP_PASSPHRASE = PASSPHRASE
    const { body } = await wrapSnapshot(buildSnapshot('u1', ROWS))
    await expect(unwrapSnapshot(JSON.parse(body), 'not it')).rejects.toBeInstanceOf(CannotDecrypt)
    // and says so, rather than asking for a passphrase that was already given
    await expect(unwrapSnapshot(JSON.parse(body), '')).rejects.toThrow(/encrypted/i)
  })

  it('refuses an envelope from a newer build rather than guessing at it', async () => {
    process.env.BACKUP_PASSPHRASE = PASSPHRASE
    const envelope = JSON.parse((await wrapSnapshot(buildSnapshot('u1', ROWS))).body)
    await expect(unwrapSnapshot({ ...envelope, drafterBackup: 99 }, PASSPHRASE)).rejects.toThrow(/newer version/i)
  })
})

describe('a host with no passphrase', () => {
  it('still writes its nightly snapshot, in the clear, and says which it did', async () => {
    // a night with NO snapshot would be far worse than a readable one
    const { body, encrypted } = await wrapSnapshot(buildSnapshot('u1', ROWS))
    expect(encrypted).toBe(false)
    expect(JSON.parse(body).items).toHaveLength(2)
  })

  it('leaves every snapshot written before encryption readable for good', async () => {
    const plain = buildSnapshot('u1', ROWS)
    // no passphrase asked for and none needed: the archive does not become
    // unreadable because the host gained a variable one Tuesday
    await expect(unwrapSnapshot(plain, '')).resolves.toEqual(plain)
  })

  it('does not mistake something else entirely for a snapshot', async () => {
    await expect(unwrapSnapshot({ hello: 'world' }, PASSPHRASE)).rejects.toThrow(/not a Drafter snapshot/i)
  })
})
