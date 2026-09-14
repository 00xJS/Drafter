import { Suspense, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { preloadable } from '../../lazyload'
import { mediaURL } from '../../media'
import type { Garment } from '../../types'

/*
 * A piece's photo cut out after the fact, from its sheet: a photo saved as it
 * was (from before the cut-out, with Use original, or offline before the web
 * engine's one-time download). It is read first, small: one that is a cut-out
 * already (white all round its edge) is left alone. Check the cut-out then
 * opens on the saved photo, and Looks good replaces it through the sheet's
 * own Replace photo. Where no cut-out can be made yet (offline, before that
 * download) there is no button, and when the device comes back online it
 * offers Cut out now.
 */

/** Check the cut-out (src/components/CutoutSheet.tsx), loaded when first opened. */
const CutoutSheet = preloadable(() => import('../CutoutSheet').then(m => m.CutoutSheet), 'CutoutSheet')

type Availability = 'native' | 'web' | 'offline' | 'unsupported'

/**
 * The button's words, or no button: none for a photo that is a cut-out
 * already or not read yet, nor where no cut-out can be made now; Cut out now
 * once the device is back online after it could not; else Cut out background.
 */
export function cutoutLaterLabel(uncut: boolean | null, can: Availability | null, wasOffline: boolean): string | null {
  if (!uncut || (can !== 'native' && can !== 'web')) return null
  return wasOffline ? 'Cut out now' : 'Cut out background'
}

/** A saved photo, from this device or the media bucket; null when neither has it. */
async function savedPhoto(id: string): Promise<Blob | null> {
  const url = await mediaURL(id)
  return url ? (await fetch(url)).blob() : null
}

export function CutoutLater({ garment, disabled, onCutout }: { garment: Garment; disabled?: boolean; onCutout(file: File): void }) {
  const small = garment.thumbId ?? garment.photoId
  // what was read, and for which photo, so a replaced photo is read afresh
  const [read, setRead] = useState<{ id: string; uncut: boolean } | null>(null)
  const uncut = small && read?.id === small ? read.uncut : null
  const [can, setCan] = useState<Availability | null>(null)
  const [wasOffline, setWasOffline] = useState(false)
  const [photo, setPhoto] = useState<File | null>(null)

  useEffect(() => {
    if (!small) return
    let live = true
    void savedPhoto(small)
      .then(blob => (blob ? import('../../cutout').then(c => c.isCutOutPhoto(blob)) : null))
      .then(
        cut => {
          if (live) setRead({ id: small, uncut: cut === false })
        },
        () => {},
      )
    return () => {
      live = false
    }
  }, [small])

  // asked again whenever the connection comes or goes
  useEffect(() => {
    if (!uncut) return
    let live = true
    const ask = () =>
      void import('../../cutout')
        .then(c => c.cutoutAvailability())
        .then(
          a => {
            if (!live) return
            setCan(a)
            if (a === 'offline') setWasOffline(true)
          },
          () => {},
        )
    ask()
    window.addEventListener('online', ask)
    window.addEventListener('offline', ask)
    return () => {
      live = false
      window.removeEventListener('online', ask)
      window.removeEventListener('offline', ask)
    }
  }, [uncut])

  const label = cutoutLaterLabel(uncut, can, wasOffline)
  const id = garment.photoId
  if (!label || !id) return null
  const open = async () => {
    const blob = await savedPhoto(id)
    if (blob) setPhoto(new File([blob], `${garment.name || 'garment'}.jpg`, { type: blob.type || 'image/jpeg' }))
  }
  return (
    <>
      <button type="button" className="btn subtle" disabled={disabled} onClick={() => void open()}>
        {label}
      </button>
      {/* over the piece sheet, not inside its footer: a dialog in a dialog's panel would be clipped by it */}
      {photo &&
        createPortal(
          <Suspense fallback={null}>
            <CutoutSheet
              photo={photo}
              onDone={(file, info) => {
                setPhoto(null)
                if (info.cutout) onCutout(file)
              }}
              onCancel={() => setPhoto(null)}
            />
          </Suspense>,
          document.body,
        )}
    </>
  )
}
