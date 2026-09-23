import { Fragment, useEffect, useRef } from 'react'
import type { BackupList } from '../admin'
import { isEnvelope, type Snapshot } from '../backupcrypto'

// Admin → Backups: each account's snapshots, and the one being read.
//
// What Read it and Download bring back is drawn directly under the row that
// asked for it. It used to come after every account's list — nineteen rows
// down on a phone, and below the fold on a computer too — so Read it fetched
// the file, opened the passphrase box out of sight and looked as if it had
// done nothing at all.

/** A snapshot being read, from the tap on its row to what is inside it. */
export interface OpenedSnapshot {
  path: string
  /** The file as fetched; null when fetching it failed. */
  raw: unknown
  /** What is inside, once it could be read. */
  snapshot: Snapshot | null
  error?: string
}

/** A signed download link, or why there is none, for one snapshot. */
export interface SnapshotLink {
  path: string
  url: string
  error?: string
}

interface Props {
  users: BackupList['users']
  busy: boolean
  /** What is running: `read:<path>` or `link:<path>` while that snapshot is being fetched. */
  pending: string
  opened: OpenedSnapshot | null
  link: SnapshotLink | null
  passphrase: string
  onPassphrase(value: string): void
  onRead(path: string): void
  onDownload(path: string): void
  onUnlock(): void
  onSave(): void
  onClose(): void
}

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1_048_576).toFixed(1)} MB`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

export function SnapshotFiles({ users, busy, pending, opened, link, passphrase, onPassphrase, onRead, onDownload, onUnlock, onSave, onClose }: Props) {
  const panel = useRef<HTMLLIElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const shown = opened?.path

  // bring the panel into view and, on a computer, put the caret where the
  // passphrase goes. Not on a phone: the keyboard that focus opens there
  // covered the very box it was typing into.
  useEffect(() => {
    if (!shown) return
    panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (window.matchMedia?.('(pointer: fine)').matches) field.current?.focus({ preventScroll: true })
  }, [shown])

  return (
    <>
      {users.map(u => (
        <div key={u.userId} className="admin-health">
          <p className="sync-line">
            <strong>{u.email ?? `${u.userId.slice(0, 8)}… (no account)`}</strong>
            <span>
              {u.files.length} snapshot{u.files.length === 1 ? '' : 's'} · {bytes(u.bytes)}
            </span>
          </p>
          <ul className="cal-sources admin-users">
            {u.files.map(f => (
              <Fragment key={f.path}>
                <li className="cal-source">
                  <span className="cal-source-name">
                    {f.date}
                    <small> · {bytes(f.size)}</small>
                  </span>
                  <button className="btn subtle" disabled={busy} onClick={() => onRead(f.path)}>
                    {pending === `read:${f.path}` ? 'Fetching…' : 'Read it'}
                  </button>
                  <button className="btn subtle" disabled={busy} onClick={() => onDownload(f.path)}>
                    {pending === `link:${f.path}` ? 'Fetching…' : 'Download'}
                  </button>
                </li>
                {link?.path === f.path && (
                  <li className="backup-open">
                    {link.error ? (
                      <p className="warn">{link.error}</p>
                    ) : (
                      <div className="copy-row">
                        <input readOnly value={link.url} aria-label="Download link" onFocus={e => e.currentTarget.select()} />
                        <a className="btn" href={link.url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </div>
                    )}
                  </li>
                )}
                {opened?.path === f.path && (
                  <li ref={panel} className="backup-open">
                    {opened.raw === null ? (
                      <>
                        <p className="warn">{opened.error ?? 'That snapshot could not be fetched.'}</p>
                        <div className="check-add">
                          <button className="btn" disabled={busy} onClick={() => onRead(f.path)}>
                            Try again
                          </button>
                          <button className="btn subtle" onClick={onClose}>
                            Close
                          </button>
                        </div>
                      </>
                    ) : opened.snapshot ? (
                      <>
                        <p className="sync-line">
                          <strong className="sync-ok">
                            {opened.snapshot.items.length} record
                            {opened.snapshot.items.length === 1 ? '' : 's'}
                          </strong>
                        </p>
                        <p className="field-hint">
                          Written {when(opened.snapshot.exportedAt)}.{' '}
                          {isEnvelope(opened.raw)
                            ? 'Decrypted here, in this browser — the passphrase was not sent anywhere.'
                            : 'Written before encryption was turned on, so it needed no passphrase.'}
                        </p>
                        <div className="check-add">
                          <button className="btn" onClick={onSave}>
                            Save the readable copy
                          </button>
                          <button className="btn subtle" onClick={onClose}>
                            Close
                          </button>
                        </div>
                        {opened.error && <p className="warn">{opened.error}</p>}
                      </>
                    ) : (
                      <>
                        <p className="field-hint">
                          Encrypted. Type the passphrase this host encrypts with (<code>BACKUP_PASSPHRASE</code> on Netlify); it stays in this browser.
                        </p>
                        <div className="check-add">
                          <input
                            ref={field}
                            type="password"
                            autoComplete="off"
                            value={passphrase}
                            placeholder="Backup passphrase"
                            aria-label="Backup passphrase"
                            onChange={e => onPassphrase(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && onUnlock()}
                          />
                          <button className="btn primary" disabled={!passphrase.trim()} onClick={onUnlock}>
                            Open it
                          </button>
                          <button className="btn subtle" onClick={onClose}>
                            Cancel
                          </button>
                        </div>
                        {opened.error && <p className="warn">{opened.error}</p>}
                      </>
                    )}
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}
