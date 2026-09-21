import type { Snapshot } from './backup.d.mts'

export const ENVELOPE_VERSION: number
export const KDF_ITERATIONS: number

export declare function backupEncryptionOn(): boolean

/** The bytes a snapshot is stored as: an envelope when the host holds BACKUP_PASSPHRASE, the body itself when it does not. */
export declare function wrapSnapshot(snapshot: Snapshot): Promise<{ body: string; encrypted: boolean }>

export declare function isEnvelope(data: unknown): boolean
