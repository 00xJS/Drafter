import { useEffect, useRef, useState } from 'react'
import { mediaURL, saveMedia } from '../../media'
import { SetForm } from '../../taskform'

interface Props {
  mediaIds: string[]
  set: SetForm
}

/** Pictures on the task, as thumbnails from the media store. */
export function Images({ mediaIds, set }: Props) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const mediaInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    ;(async () => {
      const map: Record<string, string> = {}
      for (const id of mediaIds) {
        const url = await mediaURL(id)
        if (url) map[id] = url
      }
      if (live) setThumbs(map)
    })()
    return () => {
      live = false
    }
  }, [mediaIds])

  async function addMedia(files: FileList | null) {
    if (!files) return
    const ids: string[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      ids.push(await saveMedia(file))
    }
    if (ids.length > 0) set(f => ({ mediaIds: [...f.mediaIds, ...ids] }))
  }

  return (
    <div className="field">
      <span>Images</span>
      <div className="media-grid">
        {mediaIds.map(id => (
          <span key={id} className="media-thumb">
            {thumbs[id] ? <img src={thumbs[id]} alt="" /> : <span className="media-missing">?</span>}
            <button type="button" className="media-remove" aria-label="Remove image" onClick={() => set(f => ({ mediaIds: f.mediaIds.filter(x => x !== id) }))}>
              ✕
            </button>
          </span>
        ))}
        <button type="button" className="media-add" onClick={() => mediaInput.current?.click()}>
          + Image
        </button>
        <input
          ref={mediaInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={e => {
            addMedia(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
