import { useRef, useState } from 'react'
import { saveFile } from '../../native'
import { STORAGE_VERSION, migrateStored } from '../../schema'
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
// tolerant reader back in.

export function ImportExport({ store }: SettingsCtx) {
  const file = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState('')

  function exportJSON() {
    const payload = { version: STORAGE_VERSION, exportedAt: new Date().toISOString(), items: store.visibleItems }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    saveFile(`drafter-${new Date().toISOString().slice(0, 10)}.json`, blob).catch(e => setNotice(`Export failed: ${(e as Error).message}`))
  }

  async function onFile(f: File) {
    try {
      const migrated = migrateStored(JSON.parse(await f.text()))
      if (!migrated) throw new Error('expected a Drafter backup (array, {version, posts} or {version, items})')
      const s = store.importItems(migrated)
      setNotice(`Imported: ${s.added} new, ${s.updated} updated, ${s.unchanged} unchanged.`)
    } catch (e) {
      setNotice(`Import failed: ${(e as Error).message}`)
    }
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
      {notice && <p className="sync-ok">{notice}</p>}
    </section>
  )
}
