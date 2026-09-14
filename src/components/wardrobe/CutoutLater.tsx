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
 * download) there is no button. A photo this device kept as it was only for
 * being offline is remembered (keptOffline), so its sheet says Cut out now
 * once the device is online, whenever it is opened.
 */

/** Check the cut-out (src/components/CutoutSheet.tsx), loaded when first opened. */
const CutoutSheet = preloadable(() => import('../CutoutSheet').then(m => m.CutoutSheet), 'CutoutSheet')

type Availability = 'native' | 'web' | 'offline' | 'unsupported'

/** What the piece sheet says when the saved photo cannot be read to cut out. */
export const UNREADABLE = 'That photo could not be read on this device — try again online'

// The photos this device kept as they were for want of a connection, newest
// last. localStorage only, never synced: another device never tried them.
const OFFLINE_KEY = 'drafter:uncut-offline'
const OFFLINE_KEEP = 200

function readOffline(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(OFFLINE_KEY) ?? '[]')
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeOffline(ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(OFFLINE_KEY, JSON.stringify(ids.slice(-OFFLINE_KEEP)))
    else localStorage.removeItem(OFFLINE_KEY)
  } catch {
    /* storage blocked or full: the sheet still offers Cut out background */
  }
}

/** A photo just saved as it was because no cut-out could be made offline. */
export function keptOffline(photoId: string): void {
  writeOffline([...readOffline().filter(id => id !== photoId), photoId])
}

/** Whether this device kept that photo as it was for being offline, and has not cut it out since. */
export function wasKeptOffline(photoId: string | undefined): boolean {
  return !!photoId && readOffline().includes(photoId)
}

function forgetOffline(photoId: string): void {
  const ids = readOffline()
  if (ids.includes(photoId)) writeOffline(ids.filter(id => id !== photoId))
}

/**
 * The button's words, or no button: none for a photo that is a cut-out
 * already or not read yet, nor where no cut-out can be made now; Cut out now
 * once the device is online for a photo kept as it was offline; else Cut out
 * background.
 */
export function cutoutLaterLabel(uncut: boolean | null, can: Availability | null, wasOffline: boolean): string | null {
  if (!uncut || (can !== 'native' && can !== 'web')) return null
  return wasOffline ? 'Cut out now' : 'Cut out background'
}

/** A saved photo, from this device or the media bucket; null when neither has it. */
async function savedPhoto(id: string): Promise<Blob | null> {
  const url = await mediaURL(id)
  if (!url) return null
  const response = await fetch(url)
  return response.ok ? response.blob() : null
}

export function CutoutLater({
  garment,
  disabled,
  onCutout,
  onError,
}: {
  garment: Garment
  disabled?: boolean
  onCutout(file: File): void
  /** A line for the piece sheet's own error, or null to clear it. */
  onError?(message: string | null): void
}) {
  const small = garment.thumbId ?? garment.photoId
  // what was read, and for which photo, so a replaced photo is read afresh
  const [read, setRead] = useState<{ id: string; uncut: boolean } | null>(null)
  const uncut = small && read?.id === small ? read.uncut : null
  const [can, setCan] = useState<Availability | null>(null)
  // offline while this sheet was open
  const [sawOffline, setSawOffline] = useState(false)
  const [opening, setOpening] = useState(false)
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
            if (a === 'offline') setSawOffline(true)
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

  const id = garment.photoId
  const label = cutoutLaterLabel(uncut, can, sawOffline || wasKeptOffline(id))
  if (!label || !id) return null
  const open = async () => {
    setOpening(true)
    onError?.(null)
    try {
      // a piece added on another device may have only its thumbnail here, and no connection to fetch the rest
      const blob = await savedPhoto(id)
      if (!blob) throw new Error(`${id} is not on this device`)
      setPhoto(new File([blob], `${garment.name || 'garment'}.jpg`, { type: blob.type || 'image/jpeg' }))
    } catch {
      onError?.(UNREADABLE)
    } finally {
      setOpening(false)
    }
  }
  return (
    <>
      <button type="button" className="btn subtle" disabled={disabled || opening} onClick={() => void open()}>
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
                // cut out, or turned down with a connection to cut it out: no longer waiting on one
                if (info.cutout || !info.offline) forgetOffline(id)
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
