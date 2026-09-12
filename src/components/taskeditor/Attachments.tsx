import { useRef } from 'react'
import { mediaURL, saveMedia } from '../../media'
import { SetForm } from '../../taskform'
import { Attachment } from '../../types'

interface Props {
  attachments: Attachment[]
  set: SetForm
  setAiError(message: string): void
}

/** Files of any type on the task, kept in the media store. */
export function Attachments({ attachments, set, setAiError }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)

  async function addFiles(files: FileList | null) {
    if (!files) return
    const added: Attachment[] = []
    for (const file of Array.from(files)) {
      const id = await saveMedia(file)
      added.push({ id, name: file.name, type: file.type || 'application/octet-stream', size: file.size })
    }
    if (added.length > 0) set(f => ({ attachments: [...f.attachments, ...added] }))
  }

  async function openAttachment(a: Attachment) {
    const url = await mediaURL(a.id)
    if (!url) return setAiError('That file is not available offline yet.')
    const link = document.createElement('a')
    link.href = url
    link.download = a.name
    link.target = '_blank'
    link.click()
  }

  return (
    <div className="field">
      <span>Files</span>
      <ul className="attachments">
        {attachments.map(a => (
          <li key={a.id}>
            <button type="button" className="attachment" onClick={() => openAttachment(a)} title="Open / download">
              📎 {a.name} <small>{a.size > 1_000_000 ? `${(a.size / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1000))} KB`}</small>
            </button>
            <button type="button" className="btn subtle" aria-label="Remove file" onClick={() => set(f => ({ attachments: f.attachments.filter(x => x.id !== a.id) }))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
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
