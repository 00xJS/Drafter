// Backup snapshots, encrypted (v3.25).
//
// A snapshot is everything one account has: its tasks, notes, people, places,
// the kitchen, and — because a snapshot is per account and filtered by
// readableRow — its journal. Until now each one was plain JSON in a private
// bucket. Private is not the same as unreadable: anyone holding the service
// key, the Supabase dashboard login, or Admin in this app could sign a link
// and read the lot. That is access control, not encryption, and the owner
// asked for the difference.
//
// So: AES-256-GCM over the snapshot body, with the key derived by PBKDF2 from
// BACKUP_PASSPHRASE, which lives on the host and never reaches a browser. The
// salt is per snapshot, so two nights of the same data are different files and
// one cracked file buys nothing.
//
// The server encrypts and NEVER decrypts. Admin's Restore reads the envelope
// and decrypts in the browser from a passphrase the owner types, so an owner
// session on its own — or a leaked signed link — is not enough to read anyone's
// journal. src/backupcrypto.ts is the other half, and unwrapSnapshot there
// must stay able to read exactly what wrapSnapshot writes here.
//
// Without BACKUP_PASSPHRASE set, a snapshot is written in the clear exactly as
// before and says so. A nightly backup that stopped happening because the host
// was missing a variable would be far worse than one that is merely readable,
// and Admin says loudly which of the two this host is doing.

import { webcrypto } from 'node:crypto'

/** The envelope's shape version. Bumped only if the format changes incompatibly. */
export const ENVELOPE_VERSION = 1
/**
 * PBKDF2 rounds. OWASP's floor for PBKDF2-HMAC-SHA256 at the time of writing;
 * this runs once per account per night, so the cost is paid by nobody waiting.
 */
export const KDF_ITERATIONS = 310_000

const b64 = bytes => Buffer.from(bytes).toString('base64')

/** Whether this host encrypts its snapshots. */
export function backupEncryptionOn() {
  return !!(process.env.BACKUP_PASSPHRASE ?? '').trim()
}

/**
 * The key for one snapshot. A fresh random salt each time, so the same
 * passphrase never derives the same key twice and the files cannot be
 * compared against each other.
 */
async function deriveKey(passphrase, salt) {
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
}

/**
 * The bytes a snapshot is stored as. With a passphrase: an envelope whose
 * `ct` is the encrypted body. Without one: the body itself, as before.
 *
 * `userId` and `exportedAt` stay OUTSIDE the ciphertext on purpose. Admin
 * lists snapshots by account and date, and the path already says both, so
 * hiding them would cost the panel its listing and hide nothing. Everything
 * that is actually private — every record — is inside `ct`.
 */
export async function wrapSnapshot(snapshot) {
  const body = JSON.stringify(snapshot)
  const passphrase = (process.env.BACKUP_PASSPHRASE ?? '').trim()
  if (!passphrase) return { body, encrypted: false }

  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(body))
  const envelope = {
    drafterBackup: ENVELOPE_VERSION,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(new Uint8Array(ct)),
    // readable without the passphrase, and already in the path
    userId: snapshot.userId,
    exportedAt: snapshot.exportedAt,
    items: null,
    note: 'Encrypted with BACKUP_PASSPHRASE. Admin → Backups → Restore decrypts it in your browser.',
  }
  return { body: JSON.stringify(envelope), encrypted: true }
}

/** Whether some parsed JSON is one of our envelopes rather than a plain snapshot. */
export function isEnvelope(data) {
  return !!data && typeof data === 'object' && Number(data.drafterBackup) >= 1 && typeof data.ct === 'string'
}
