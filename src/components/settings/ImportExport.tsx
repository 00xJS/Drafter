import { useRef, useState } from 'react'
import { saveFile } from '../../native'
import { STORAGE_VERSION, migrateStored } from '../../schema'
import type { Store } from '../../store'
import type { SettingsCtx } from './context'

// Taking your data out, and putting it back.
//
// These two were on the Tasks toolbar until v3.28, where at 375pt they took
// the only free slot on the row and pushed the Trash behind an "Import /
// Export ▾" menu: the control nobody uses was visible and the one everybody
// reaches for was not. Moving data in and out is a once-a-year thing and
// belongs with the other data controls, not on the page you work from daily.
//
// Nothing about what they DO has changed — the same payload out, the same
// tolerant reader back in — except that a server snapshot is only taken back
// by the account it is a snapshot of (importRefusal).

/** What an export or import has to say, and whether it went well: a failure is not drawn in the success green. */
export interface Notice {
  text: string
  ok: boolean
}

/**
 * Why this file must not be imported into the signed-in account, or null when
 * it may be. A nightly snapshot names the account it was taken of (`userId`),
 * and importing merges by id and files every record under whoever imports it:
 * the other member's snapshot would come back as the importer's own records,
 * their journal included. A file that names no account — an export from here,
 * an older backup — is taken as before, and so is anything in local mode,
 * where there is no account to file it under.
 */
export function importRefusal(raw: unknown, myId: string | null, signedIn: boolean): string | null {
  const owner = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { userId?: unknown }).userId : undefined
  if (typeof owner !== 'string' || !owner || !signedIn) return null
  if (!myId) return 'Nothing was imported: Drafter could not tell which account is signed in, so it could not check whose backup this is. Try again in a moment.'
  if (owner !== myId) return 'Nothing was imported: this backup is of another account. Import it while signed in as that account — here, its records would be filed as yours.'
  return null
}

/** Read one file and merge it into the store, or say why not. */
export async function importFile(file: Blob, ctx: { myId: string | null; signedIn: boolean; importItems: Store['importItems'] }): Promise<Notice> {
  try {
    const raw: unknown = JSON.parse(await file.text())
    const refused = importRefusal(raw, ctx.myId, ctx.signedIn)
    if (refused) return { text: refused, ok: false }
    const migrated = migrateStored(raw)
    if (!migrated) throw new Error('expected a Drafter backup (array, {version, posts} or {version, items})')
    const s = ctx.importItems(migrated)
    return { text: `Imported: ${s.added} new, ${s.updated} updated, ${s.unchanged} unchanged.`, ok: true }
  } catch (e) {
    return { text: `Import failed: ${(e as Error).message}`, ok: false }
  }
}

/** An export's or import's outcome: green when it went well, and said as a warning when it did not. */
export function ImportNotice({ notice }: { notice: Notice }) {
  return (
    <p className={notice.ok ? 'sync-ok' : 'warn'} role={notice.ok ? undefined : 'alert'}>
      {notice.text}
    </p>
  )
}

export function ImportExport({ store, household, supabaseOn }: SettingsCtx) {
  const file = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  function exportJSON() {
    const payload = { version: STORAGE_VERSION, exportedAt: new Date().toISOString(), items: store.visibleItems }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    saveFile(`drafter-${new Date().toISOString().slice(0, 10)}.json`, blob).catch(e => setNotice({ text: `Export failed: ${(e as Error).message}`, ok: false }))
  }

  async function onFile(f: File) {
    setNotice(await importFile(f, { myId: household.myId, signedIn: supabaseOn, importItems: store.importItems }))
  }

  return (
    <section className="settings-section g-data">
      <h3>Export and import</h3>
      <p className="field-hint">
        A file of everything this account can see, which you can keep anywhere. Importing one merges it in by id — nothing is replaced and nothing is lost, so the same
        file twice changes nothing the second time. This is not the nightly backup; that runs on the server and Admin holds it.
      </p>
      <div className="check-add">
        <button className="btn" onClick={exportJSON}>
          Export a file
        </button>
        <button className="btn" onClick={() => file.current?.click()}>
          Import a file
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
            e.target.value = ''
          }}
        />
      </div>
      {notice && <ImportNotice notice={notice} />}
    </section>
  )
}
