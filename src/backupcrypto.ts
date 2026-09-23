// Reading an encrypted backup snapshot, in the browser (v3.25).
//
// The other half of netlify/functions/lib/backupcrypto.mjs. The server
// encrypts a snapshot with BACKUP_PASSPHRASE and never decrypts one: this
// does, from a passphrase the owner types into Admin, so neither an owner
// session nor a leaked signed link is enough on its own to read anyone's
// journal. The passphrase is never sent anywhere — it is used here and
// forgotten when the panel closes.

/** The envelope the server writes. Only `ct` is secret; the rest is what the path already says. */
export interface BackupEnvelope {
  drafterBackup: number
  alg: string
  kdf: string
  iterations: number
  salt: string
  iv: string
  ct: string
  userId?: string
  exportedAt?: string
}

/** A snapshot, once it can be read: exactly what buildSnapshot wrote. */
export interface Snapshot {
  exportedAt: string
  userId: string
  items: unknown[]
}

/** Whether this is an envelope rather than a snapshot written before encryption was turned on. */
export function isEnvelope(data: unknown): data is BackupEnvelope {
  const d = data as BackupEnvelope | null
  return !!d && typeof d === 'object' && Number(d.drafterBackup) >= 1 && typeof d.ct === 'string'
}

const bytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), c => c.charCodeAt(0))

/** The wrong passphrase, a damaged file, or a format this build has never heard of. */
export class CannotDecrypt extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CannotDecrypt'
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
}

/**
 * The snapshot inside `data`, whatever shape it arrived in.
 *
 * A file written before encryption was turned on is already the snapshot and
 * is handed back untouched — the whole archive does not become unreadable
 * because the host gained a variable one Tuesday. An envelope needs the
 * passphrase; AES-GCM authenticates, so a wrong one fails rather than
 * producing plausible rubbish.
 */
export async function unwrapSnapshot(data: unknown, passphrase: string): Promise<Snapshot> {
  if (!isEnvelope(data)) {
    const plain = data as Snapshot | null
    if (plain && Array.isArray(plain.items)) return plain
    throw new CannotDecrypt('That file is not a Drafter snapshot.')
  }
  if (data.drafterBackup > 1) throw new CannotDecrypt('That snapshot was written by a newer version of Drafter than this one.')
  // the host trims BACKUP_PASSPHRASE before deriving its key, so a pasted
  // passphrase that brought a space or a line break with it is still the same one
  const typed = passphrase.trim()
  if (!typed) throw new CannotDecrypt('This snapshot is encrypted. Type the backup passphrase to read it.')
  // said apart from a wrong passphrase, which the catch below would call it
  if (!globalThis.crypto?.subtle) throw new CannotDecrypt('This browser cannot decrypt snapshots. Open Admin in another browser or on a computer.')
  let text: string
  try {
    const key = await deriveKey(typed, bytes(data.salt), Number(data.iterations) || 310_000)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(data.iv) as BufferSource }, key, bytes(data.ct) as BufferSource)
    text = new TextDecoder().decode(plain)
  } catch {
    throw new CannotDecrypt('That passphrase does not open this snapshot.')
  }
  const snapshot = JSON.parse(text) as Snapshot
  if (!snapshot || !Array.isArray(snapshot.items)) throw new CannotDecrypt('The snapshot opened, but there is nothing readable inside it.')
  return snapshot
}
