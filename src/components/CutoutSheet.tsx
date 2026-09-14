import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { canPickGarment, extractGarment, garmentFile, releaseGarmentCutout, type CutoutMethod, type CutoutReason, type CutoutResult } from '../cutout'
import { CUTOUT_TOTAL_BYTES } from '../cutoutassets'
import { pointInContainedImage, type Point } from '../cutoutmath'
import { Modal, ModalHead } from './Modal'

/*
 * "Check the cut-out": the photo as picked and the garment on white, before
 * either is kept. On the phone, one stage with a Cut-out · Photo switch; on a
 * desktop, the two side by side. A tap on the photo picks the garment (the web
 * engine runs from that point). Looks good hands over the cut-out, Use
 * original the photo, and Retake opens the picker again.
 *
 * CutoutPreview is props only, so every state renders in a static test.
 * CutoutSheet runs the cut-out and wraps the preview in the app's Modal. The
 * wardrobe loads it at the merge with
 * preloadable(() => import('./CutoutSheet').then(m => m.CutoutSheet)).
 */

export type PreviewState = 'preparing' | 'downloading' | 'cutting' | 'done' | 'unavailable'

export interface CutoutPreviewProps {
  photoUrl: string
  cutoutUrl?: string
  state: PreviewState
  progress?: { loaded: number; total: number }
  reason?: CutoutReason
  doubtful?: boolean
  point?: Point
  /** The web engine can run here (bundled, cached or online), so a tap on the photo can pick. */
  canPick: boolean
  view: 'cutout' | 'photo'
  onView(v: 'cutout' | 'photo'): void
  /** A tap at this point; null for a keyboard press, which runs the automatic seeds again. */
  onPick(point: Point | null): void
  onAccept(): void
  onUseOriginal(): void
  onRetake(): void
  onRetry?(): void
}

/** Megabytes as the preview writes them: binary, to one decimal. */
const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1)

const UNAVAILABLE: Record<CutoutReason, string> = {
  'no-garment': 'Couldn’t find a garment here. Tap it in the photo, or use the original.',
  offline: `Cutting out needs a one-time download (${mb(CUTOUT_TOTAL_BYTES)} MB), and you’re offline. Use the photo as it is for now.`,
  unsupported: 'This browser can’t cut out photos. Use the photo as it is.',
  failed: 'The cut-out didn’t work this time.',
  cancelled: 'The cut-out didn’t work this time.',
}

export function CutoutPreview(props: CutoutPreviewProps) {
  const { photoUrl, cutoutUrl, state, progress, reason, doubtful, point, canPick, view, onView, onPick, onAccept, onUseOriginal, onRetake, onRetry } = props
  // the photo's own size, which places the dot: known once it has loaded
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const accept = useRef<HTMLButtonElement>(null)
  const done = state === 'done' && !!cutoutUrl
  const unavailable = state === 'unavailable'
  const pickable = canPick && (done || (unavailable && reason === 'no-garment'))
  const failed = unavailable && (reason === 'failed' || reason === 'cancelled')

  useEffect(() => {
    if (done) accept.current?.focus({ preventScroll: true })
  }, [done])

  const pick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    // Enter or Space: there is no position, so the automatic seeds run again
    if (e.detail === 0) return onPick(null)
    const img = e.currentTarget.querySelector('img')
    if (!img?.naturalWidth) return
    const box = img.getBoundingClientRect()
    const at = pointInContainedImage({ x: e.clientX - box.left, y: e.clientY - box.top }, box, { width: img.naturalWidth, height: img.naturalHeight })
    if (at) onPick(at)
  }

  const photo = photoUrl ? (
    <img src={photoUrl} alt="Your photo" onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} />
  ) : null
  // drawn in the photo's own coordinates, so `meet` lays it over the contained image exactly
  const dot =
    point && natural ? (
      <svg className="cutout-dot" viewBox={`0 0 ${natural.width} ${natural.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <circle cx={point.x * natural.width} cy={point.y * natural.height} r={Math.max(natural.width, natural.height) * 0.018} />
      </svg>
    ) : null
  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0
  const status =
    state === 'preparing'
      ? 'Getting the photo ready…'
      : state === 'downloading'
        ? `Getting the cut-out ready · ${mb(progress?.loaded ?? 0)} of ${mb(progress?.total ?? CUTOUT_TOTAL_BYTES)} MB`
        : state === 'cutting'
          ? 'Cutting out…'
          : unavailable
            ? UNAVAILABLE[reason ?? 'failed']
            : ''

  return (
    <>
      <div className="modal-body cutout" data-state={state}>
        {done && (
          <div className="segmented cutout-seg" role="group" aria-label="Show">
            <button type="button" className={view === 'cutout' ? 'seg on' : 'seg'} aria-pressed={view === 'cutout'} onClick={() => onView('cutout')}>
              Cut-out
            </button>
            <button type="button" className={view === 'photo' ? 'seg on' : 'seg'} aria-pressed={view === 'photo'} onClick={() => onView('photo')}>
              Photo
            </button>
          </div>
        )}
        <div className={done ? 'cutout-panes two' : 'cutout-panes'} data-view={done ? view : 'photo'}>
          <figure className="cutout-pane cutout-photo">
            <figcaption>Photo</figcaption>
            {pickable ? (
              <button type="button" className="cutout-stage cutout-pick" aria-label="Tap the garment to pick it" onClick={pick}>
                {photo}
                {dot}
              </button>
            ) : (
              <div className="cutout-stage">
                {photo}
                {dot}
                {state === 'cutting' && <span className="cutout-spinner" aria-hidden="true" />}
              </div>
            )}
          </figure>
          {done && (
            <figure className="cutout-pane cutout-result">
              <figcaption>Cut-out</figcaption>
              <div className="cutout-stage cutout-white">
                <img src={cutoutUrl} alt="The garment on white" />
              </div>
            </figure>
          )}
        </div>
        <p className="cutout-status" aria-live="polite">
          {status}
        </p>
        {state === 'downloading' && (
          <>
            <div className="cutout-bar" role="progressbar" aria-label="Getting the cut-out ready" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span style={{ width: `${percent}%` }} />
            </div>
            <small className="cutout-small">Only the first time. The cut-out is made on this device.</small>
          </>
        )}
        {done && doubtful && <p className="cutout-note">This may have missed the garment. Tap it in the photo, or use the original.</p>}
        {done && canPick && <small className="cutout-small">Picked the wrong thing? Tap the garment in the photo.</small>}
      </div>
      <footer className="modal-foot">
        <button type="button" className="btn subtle" onClick={onRetake}>
          Retake
        </button>
        <span className="spacer" />
        {failed && onRetry && (
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        )}
        <button type="button" className={unavailable ? 'btn primary' : 'btn'} onClick={onUseOriginal}>
          Use original
        </button>
        {done && (
          <button ref={accept} type="button" className="btn primary" onClick={onAccept}>
            Looks good
          </button>
        )}
      </footer>
    </>
  )
}

interface Job {
  photo: Blob
  point?: Point
  web: boolean
  n: number
}

/**
 * The cut-out behind the sheet. It owns the object URLs (revoked when replaced
 * or unmounted), aborts a run the sheet has moved past, runs again after a tap
 * or a retake, and lets the web segmenter go idle on unmount.
 */
function useGarmentCutout(initial: Blob) {
  const [job, setJob] = useState<Job>({ photo: initial, web: false, n: 0 })
  const [photoUrl, setPhotoUrl] = useState('')
  const [state, setState] = useState<PreviewState>('preparing')
  const [progress, setProgress] = useState<{ loaded: number; total: number }>()
  const [result, setResult] = useState<CutoutResult>()
  const [cutoutUrl, setCutoutUrl] = useState('')
  const [canPick, setCanPick] = useState(false)

  useEffect(() => {
    const url = URL.createObjectURL(job.photo)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [job.photo])

  useEffect(() => {
    const controller = new AbortController()
    let live = true
    setState('preparing')
    setProgress(undefined)
    setResult(undefined)
    void extractGarment(job.photo, {
      point: job.point,
      engine: job.web ? 'web' : 'auto',
      signal: controller.signal,
      onProgress: p => {
        if (!live) return
        if (p.phase === 'cutting') return setState('cutting')
        setState('downloading')
        if (p.total) setProgress({ loaded: p.loaded ?? 0, total: p.total })
      },
    }).then(r => {
      if (!live) return
      setResult(r)
      setState(r.method === 'none' ? 'unavailable' : 'done')
    })
    // A run the sheet has moved past (a tap, a retake, closing) is aborted. The
    // download it may have started is shared and runs on, so Use original in
    // the middle of it still leaves the next photo ready.
    return () => {
      live = false
      controller.abort()
    }
  }, [job])

  useEffect(() => {
    if (!result || result.method === 'none') {
      setCutoutUrl('')
      return
    }
    const url = URL.createObjectURL(result.image)
    setCutoutUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [result])

  useEffect(() => {
    let live = true
    void canPickGarment().then(ok => {
      if (live) setCanPick(ok)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => () => releaseGarmentCutout(), [])

  return {
    photo: job.photo,
    photoUrl,
    state,
    progress,
    result,
    cutoutUrl,
    canPick,
    point: job.point ?? result?.point,
    // A tap picks among Vision's subjects first, where it lifted this photo
    // (the extractor moves on to the web engine when Vision has nothing more);
    // a key press asks the web engine's own automatic seeds for a second opinion.
    pick: (point: Point | null) => setJob(j => ({ photo: j.photo, point: point ?? undefined, web: point === null, n: j.n + 1 })),
    retry: () => setJob(j => ({ ...j, n: j.n + 1 })),
    retake: (photo: Blob) => setJob(j => ({ photo, web: false, n: j.n + 1 })),
  }
}

export interface CutoutSheetProps {
  photo: Blob
  /** "Looks good" hands over the cut-out; "Use original" the photo as picked. */
  onDone(file: File, info: { cutout: boolean; method: CutoutMethod }): void
  /** ✕, Escape or the backdrop: the add is cancelled. */
  onCancel(): void
}

/** "shirt" for shirt.heic; "garment" for a photo with no name. */
const stem = (photo: Blob) => (photo instanceof File && photo.name ? photo.name.replace(/\.[^.]*$/, '') : 'garment')

export function CutoutSheet({ photo, onDone, onCancel }: CutoutSheetProps) {
  const cut = useGarmentCutout(photo)
  const [view, setView] = useState<'cutout' | 'photo'>('cutout')
  const picker = useRef<HTMLInputElement>(null)
  const { result } = cut
  return (
    <Modal onClose={onCancel} className="modal cutout-sheet">
      <ModalHead title="Check the cut-out" />
      <CutoutPreview
        photoUrl={cut.photoUrl}
        cutoutUrl={cut.cutoutUrl}
        state={cut.state}
        progress={cut.progress}
        reason={result?.reason}
        doubtful={result?.doubtful}
        point={cut.point}
        canPick={cut.canPick}
        view={view}
        onView={setView}
        onPick={point => {
          setView('cutout')
          cut.pick(point)
        }}
        onAccept={() => {
          if (result && result.method !== 'none') onDone(garmentFile(result.image, `${stem(cut.photo)}-cutout.jpg`), { cutout: true, method: result.method })
        }}
        onUseOriginal={() => onDone(cut.photo instanceof File ? cut.photo : garmentFile(cut.photo), { cutout: false, method: 'none' })}
        onRetake={() => {
          // synchronously, inside the tap: iOS Safari and WKWebView block a picker opened after an await
          picker.current?.click()
        }}
        onRetry={cut.retry}
      />
      <input
        ref={picker}
        type="file"
        accept="image/*"
        hidden
        onChange={e => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          setView('cutout')
          cut.retake(file)
        }}
      />
    </Modal>
  )
}
