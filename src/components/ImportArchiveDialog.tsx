import { useRef, useState } from 'react'
import { Store } from '../store'
import { importArchiveFile } from '../importers'

interface Props {
  store: Store
  onClose(): void
}

export function ImportArchiveDialog({ store, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  async function onFile(file: File) {
    setBusy(true)
    setError('')
    setResult('')
    try {
      const buf = await file.arrayBuffer()
      const r = importArchiveFile(file.name, buf)
      const summary = store.importPosts(r.posts)
      const parts = [
        `${r.source}: found ${r.posts.length} posts — ${summary.added} new, ${summary.updated} updated, ${summary.unchanged} already in your library.`,
      ]
      if (r.skippedRetweets > 0) parts.push(`Skipped ${r.skippedRetweets} retweets.`)
      setResult(parts.join(' '))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal narrow" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Import an account archive</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <p>
            Both platforms let you download your full post history for free — no API keys needed. Request the archive,
            then drop the file here.
          </p>

          <div className="archive-help">
            <h3>X (Twitter)</h3>
            <p>
              x.com → Settings → Your account → <strong>Download an archive of your data</strong>. Import the whole
              .zip, or just <code>data/tweets.js</code> from inside it (better for very large archives). Likes and
              reposts per tweet come along; impressions aren't in the archive.
            </p>
            <h3>Instagram</h3>
            <p>
              Accounts Center → Your information and permissions → <strong>Download your information</strong> — choose{' '}
              <strong>JSON</strong> format. Import the .zip or <code>your_instagram_activity/content/posts_1.json</code>.
              Captions and dates come along; metrics can be filled in later.
            </p>
          </div>

          <div className="archive-drop">
            <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Importing…' : 'Choose archive file (.zip / .js / .json)'}
            </button>
            <input
              ref={input}
              type="file"
              accept=".zip,.js,.json,application/zip,application/json,text/javascript"
              hidden
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
                e.target.value = ''
              }}
            />
          </div>

          {result && <div className="notice">{result}</div>}
          {error && <div className="notice error">Import failed: {error}</div>}
          <p className="field-hint">
            Re-importing the same archive is safe — posts are matched by their platform id, and anything you've edited
            in Drafter wins over the archive copy.
          </p>
        </div>

        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
