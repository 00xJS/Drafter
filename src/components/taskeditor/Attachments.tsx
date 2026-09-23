import { useRef, useState } from 'react'
import { mediaURL, saveMedia } from '../../media'
import { saveFile } from '../../native'
import { SetForm } from '../../taskform'
import { Attachment } from '../../types'

interface Props {
  attachments: Attachment[]
  set: SetForm
}

/**
 * Where opening one file has got to, said under its own row: still coming,
 * here but waiting for a tap of its own, or why it could not be opened.
 */
export type Opening = { id: string; phase: 'fetching' } | { id: string; phase: 'ready'; blob: Blob } | { id: string; phase: 'note'; text: string }

export const NOT_OFFLINE = 'That file is not available offline yet.'

/** The file itself, typed as it was attached, or null when this device has not got it and cannot fetch it now. */
async function attachmentBlob(a: Attachment): Promise<Blob | null> {
  const url = await mediaURL(a.id)
  if (!url) return null
  const blob = await (await fetch(url)).blob()
  return blob.type ? blob : new Blob([blob], { type: a.type })
}

/**
 * Open a file: fetch it, then hand it to saveFile — the share sheet in the
 * iPhone app (Save to Files, or open it in another app), a download in a
 * browser. It used to click a blob: download link, which does nothing in the
 * app: WKWebView has no downloads and Capacitor passes the link on to Safari,
 * which cannot open it. What comes back is what to say under the file's row,
 * or null for nothing to say.
 */
export async function openAttachment(
  a: Attachment,
  deps: { load?: (a: Attachment) => Promise<Blob | null>; save?: (name: string, blob: Blob) => Promise<void> } = {},
): Promise<Opening | null> {
  const { load = attachmentBlob, save = saveFile } = deps
  const blob = await load(a).catch(() => null)
  if (!blob) return { id: a.id, phase: 'note', text: NOT_OFFLINE }
  try {
    await save(a.name, blob)
    return null
  } catch (e) {
    // The share sheet only opens from a tap, and a file that had to come down
    // from the server can outlast the tap that asked for it; WebKit then
    // refuses. The file is here now, so a Save button gives it a tap of its own.
    if ((e as Error).name === 'NotAllowedError') return { id: a.id, phase: 'ready', blob }
    return { id: a.id, phase: 'note', text: (e as Error).message }
  }
}

const sizeOf = (bytes: number) => (bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`)

/** The files, each with what opening it has to say directly under it. */
export function AttachmentList({
  attachments,
  opening,
  onOpen,
  onSave,
  onRemove,
}: {
  attachments: Attachment[]
  opening: Opening | null
  onOpen(a: Attachment): void
  onSave(a: Attachment, blob: Blob): void
  onRemove(id: string): void
}) {
  return (
    <ul className="attachments">
      {attachments.flatMap(a => {
        const mine = opening?.id === a.id ? opening : null
        const row = (
          <li key={a.id}>
            <button type="button" className="attachment" onClick={() => onOpen(a)} title="Open / download">
              📎 {a.name} <small>{mine?.phase === 'fetching' ? 'Fetching…' : sizeOf(a.size)}</small>
            </button>
            <button type="button" className="btn subtle" aria-label="Remove file" onClick={() => onRemove(a.id)}>
              ✕
            </button>
          </li>
        )
        if (mine?.phase === 'ready') {
          return [
            row,
            <li key={`${a.id}:open`}>
              <button type="button" className="btn primary" aria-label={`Save ${a.name}`} onClick={() => onSave(a, mine.blob)}>
                Save
              </button>
              <small className="muted">Downloaded. Save opens it or keeps it.</small>
            </li>,
          ]
        }
        if (mine?.phase === 'note') {
          return [
            row,
            <li key={`${a.id}:open`}>
              <span className="warn" role="alert">
                {mine.text}
              </span>
            </li>,
          ]
        }
        return [row]
      })}
    </ul>
  )
}

/** Files of any type on the task, kept in the media store. */
export function Attachments({ attachments, set }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [opening, setOpening] = useState<Opening | null>(null)

  async function addFiles(files: FileList | null) {
    if (!files) return
    const added: Attachment[] = []
    for (const file of Array.from(files)) {
      const id = await saveMedia(file)
      added.push({ id, name: file.name, type: file.type || 'application/octet-stream', size: file.size })
    }
    if (added.length > 0) set(f => ({ attachments: [...f.attachments, ...added] }))
  }

  async function open(a: Attachment) {
    // one at a time: a second tap while a file is on its way is not a second file
    if (opening?.phase === 'fetching') return
    setOpening({ id: a.id, phase: 'fetching' })
    setOpening(await openAttachment(a))
  }

  // called straight from the Save tap, so the share sheet has the gesture it needs
  async function save(a: Attachment, blob: Blob) {
    setOpening(null)
    try {
      await saveFile(a.name, blob)
    } catch (e) {
      setOpening({ id: a.id, phase: 'note', text: (e as Error).message })
    }
  }

  return (
    <div className="field">
      <span>Files</span>
      <AttachmentList
        attachments={attachments}
        opening={opening}
        onOpen={a => void open(a)}
        onSave={(a, blob) => void save(a, blob)}
        onRemove={id => set(f => ({ attachments: f.attachments.filter(x => x.id !== id) }))}
      />
      <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
        + Attach a file
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={e => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
