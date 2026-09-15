import { Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { newerStamp } from '../../itemops'
import { shortDay } from '../../kitchen'
import { preloadable, warm } from '../../lazyload'
import { NotSignedIn, imageFiles, saveMedia } from '../../media'
import { PhotoUnreadable, prepareGarmentPhoto } from '../../photo'
import { GARMENT_TYPES, GARMENT_TYPE_META, type Garment, type GarmentType, type Outfit } from '../../types'
import { uid } from '../../utils'
import { costLine, garmentStats, outfitLabel, renamed, showingBack, starred, suggestedNames, withBack, wornLine, type WearIndex } from '../../wardrobe'
import { Bars } from '../bits'
import { ConfirmButton } from '../ConfirmButton'
import { Icon } from '../Icon'
import { Modal, ModalHead } from '../Modal'
import { CutoutLater, keptOffline } from './CutoutLater'
import { GarmentView, hasBack, mainSide, type Side } from './GarmentPhoto'
import { PieceDetails } from './PieceDetails'

/** What the sheet is for: adding a piece (of a type, when the way in named one), or one piece. */
export type SheetMode = { kind: 'add'; type?: GarmentType } | { kind: 'edit'; id: string }

interface Props {
  mode: SheetMode
  garments: Garment[]
  outfits: Outfit[]
  byId: ReadonlyMap<string, Garment>
  ix: WearIndex
  todayKey: string
  /** The account signed in: a piece's photos are filed under its own personal/ folder. */
  userId?: string | null
  /** A new piece, to save; the segment says so, with Undo. */
  onCreate(g: Garment): void
  /** An edit of a piece; with a message, a toast whose Undo writes `before` back. */
  onEdit(before: Garment, after: Garment, msg?: string): void
  onRetire(g: Garment, on: boolean): void
  onDelete(g: Garment): void
  onWearToday(g: Garment): void
  /** A worn day tapped: the composer on that day. */
  onGoDay(day: string): void
  /** A piece it is worn with tapped: that piece's sheet. */
  onOpenPiece(id: string): void
  onClose(): void
}

/**
 * Check the cut-out (src/components/CutoutSheet.tsx): every photo picked here
 * goes through it first, and the piece keeps what it hands back, the garment
 * on white or the photo as picked. Loaded on first use.
 */
const CutoutSheet = preloadable(() => import('../CutoutSheet').then(m => m.CutoutSheet), 'CutoutSheet')

/**
 * As Add clothing opens: the cut-out sheet's code, and the cut-out's engine
 * where this device needs one (nothing on an iPhone that lifts subjects
 * itself; the one-time download on the web), so both are ready by the time a
 * photo is. Quiet on failure: the sheet fetches again when it opens.
 */
function warmCutout(): void {
  warm(CutoutSheet.preload, () => import('../../cutout').then(c => c.prepareGarmentCutout()))
}

const failure = (err: unknown) => (err instanceof PhotoUnreadable || err instanceof NotSignedIn ? err.message : 'That photo could not be kept on this device — try again')

/**
 * A photo made ready, filed under this account: the photo, then its thumbnail
 * as that photo's (MediaItem.thumbOf), so a sign-out counts the two as one.
 * A front and a back alike.
 */
async function fileAway(p: { photo: Blob; thumb: Blob }, userId?: string | null): Promise<{ photoId: string; thumbId: string }> {
  const photoId = await saveMedia(p.photo, { personal: true, userId })
  const thumbId = await saveMedia(p.thumb, { personal: true, userId, thumbOf: photoId })
  return { photoId, thumbId }
}

function TypeChips({ type, onChange }: { type: GarmentType; onChange(t: GarmentType): void }) {
  return (
    <div className="garment-types" role="radiogroup" aria-label="Type" aria-required="true">
      {GARMENT_TYPES.map(t => (
        <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? 'toggle on' : 'toggle'} onClick={() => onChange(t)}>
          {GARMENT_TYPE_META[t].label}
        </button>
      ))}
    </div>
  )
}

/** What the cut-out sheet handed back for a photo: its cut-out, or the photo as picked (`offline`: only for want of a connection). */
type Picked = { file: File; cutout: boolean; offline?: boolean }

type Ready = { photo: Blob; thumb: Blob; color?: string; preview: string }

/** A photo made ready — decoded once, sized twice, its colour sampled — with a preview URL let go when it goes. */
function usePrepared(picked: Picked | null): { ready: Ready | null; busy: boolean; error: string | null } {
  const [done, setDone] = useState<{ picked: Picked; ready: Ready | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!picked) return
    let live = true
    let preview: string | null = null
    // the cut-out step: a cut-out of 1200px or less is kept as the photo, not encoded again
    prepareGarmentPhoto(picked.file, { cutout: picked.cutout }).then(
      p => {
        preview = URL.createObjectURL(p.photo)
        if (live) setDone({ picked, ready: { ...p, preview }, error: null })
        else URL.revokeObjectURL(preview)
      },
      err => {
        if (live) setDone({ picked, ready: null, error: failure(err) })
      },
    )
    return () => {
      live = false
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [picked])
  const current = done !== null && done.picked === picked
  return { ready: current ? done.ready : null, busy: !!picked && !current, error: current ? done.error : null }
}

/** The piece sheet: add one (or a queue of them from several photos), or everything about one. */
export function GarmentSheet(props: Props) {
  const { mode } = props
  return mode.kind === 'add' ? <AddPiece preset={mode.type} userId={props.userId} onCreate={props.onCreate} onClose={props.onClose} /> : <EditPiece {...props} id={mode.id} />
}

function AddPiece({ preset, userId, onCreate, onClose }: { preset?: GarmentType; userId?: string | null; onCreate(g: Garment): void; onClose(): void }) {
  const [queue, setQueue] = useState<File[]>([])
  const [at, setAt] = useState(0)
  // each choice of photos is a new round, so the cut-out sheet starts afresh on its first
  const [round, setRound] = useState(0)
  const file = queue[at] ?? null
  // what the cut-out sheet handed back for `file`; until it answers, it is open on it
  const [picked, setPicked] = useState<Picked | null>(null)
  const checking = !!file && !picked
  const { ready, busy, error } = usePrepared(picked)
  // the back, once there is a front: optional, through the same check
  const [backFile, setBackFile] = useState<File | null>(null)
  const [backPicked, setBackPicked] = useState<Picked | null>(null)
  const checkingBack = !!backFile && !backPicked
  const back = usePrepared(backPicked)
  const [lastSaved, setLastSaved] = useState<GarmentType | null>(null)
  const [type, setType] = useState<GarmentType>(preset ?? 'top')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const names = suggestedNames(type, ready?.color)

  useEffect(warmCutout, [])

  const clearBack = () => {
    setBackFile(null)
    setBackPicked(null)
  }
  const choose = (files: FileList | readonly File[] | null) => {
    const chosen = Array.from(files ?? [])
    // a photo taken mid-save would move the queue under the save still reading it
    if (chosen.length === 0 || saving) return
    setQueue(chosen)
    setAt(0)
    setRound(r => r + 1)
    setPicked(null)
    clearBack()
    setName('')
    setNotes('')
    setFailed(null)
  }
  /** Files dropped on the sheet: the photos among them, as if picked; with none, a word why. */
  const drop = (files: FileList) => {
    setDragging(false)
    const photos = imageFiles(files)
    if (photos.length > 0) choose(photos)
    else setFailed('That is not a photo — try a JPEG or PNG')
  }
  // on a desktop, a photo pasted while the sheet is open, or dropped anywhere
  // on it, is taken as if it were picked, through the filter a note's photos go
  // through; pasted text still goes into the fields as ever, and a dropped file
  // is never opened by the browser in the app's place
  const take = useRef({ choose, drop })
  take.current = { choose, drop }
  useEffect(() => {
    const carriesFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const onPaste = (e: ClipboardEvent) => {
      const photos = imageFiles(e.clipboardData?.files ?? [])
      if (photos.length === 0) return
      e.preventDefault()
      take.current.choose(photos)
    }
    const onDragOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer || !carriesFiles(e)) return
      e.preventDefault()
      take.current.drop(e.dataTransfer.files)
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])
  /** On to the next photo picked (typed as the way in said, else as the last one saved), or done. */
  const next = (saved?: GarmentType) => {
    if (at + 1 >= queue.length) {
      onClose()
      return
    }
    setAt(at + 1)
    setPicked(null)
    clearBack()
    setName('')
    setNotes('')
    setFailed(null)
    setType(preset ?? saved ?? lastSaved ?? 'top')
  }
  /** The cut-out sheet closed without a choice: that photo is not used, and the next one picked comes up, or the picker again. */
  const skipPhoto = () => {
    setPicked(null)
    if (at + 1 < queue.length) setAt(at + 1)
    else {
      setQueue([])
      setAt(0)
    }
  }
  const waiting = saving || busy || (!!file && !ready) || back.busy || checkingBack
  const save = async () => {
    if (waiting) return
    setSaving(true)
    try {
      // the photos go into this device's store, and its upload queue, first; the piece then points at them
      const front = ready ? await fileAway(ready, userId) : undefined
      // a back rides only with a front: its + Back photo shows once there is one
      const backIds = ready && back.ready ? await fileAway(back.ready, userId) : undefined
      const now = new Date().toISOString()
      onCreate({
        kind: 'garment',
        id: uid(),
        name: name.trim().slice(0, 80) || names[0],
        type,
        photoId: front?.photoId,
        thumbId: front?.thumbId,
        backPhotoId: backIds?.photoId,
        backThumbId: backIds?.thumbId,
        color: ready?.color,
        notes: notes.trim().slice(0, 500) || undefined,
        createdAt: now,
        updatedAt: now,
      })
      // kept as it was only for want of a connection: its sheet offers Cut out now once online
      if (front && picked?.offline) keptOffline(front.photoId)
      if (backIds && backPicked?.offline) keptOffline(backIds.photoId)
      setLastSaved(type)
      next(type)
    } catch (err) {
      setFailed(failure(err))
    } finally {
      setSaving(false)
    }
  }
  // a photo made ready and not saved is the one thing here worth asking about
  const close = () => {
    if ((ready || back.ready) && !window.confirm('Discard this photo?')) return
    onClose()
  }

  return (
    <Modal onClose={close} className="modal narrow garment-sheet">
      <ModalHead title={queue.length > 1 ? `Add clothing · ${at + 1} of ${queue.length}` : 'Add clothing'}>
        {queue.length > 1 && (
          <button type="button" className="btn subtle" onClick={() => next()}>
            Skip
          </button>
        )}
      </ModalHead>
      <div className="modal-body">
        {/* the label is the target, so the tap itself opens the picker: on an
            iPhone, Take Photo, Photo Library or Choose File. A file dragged
            over it lights it until the pointer leaves it — not as it crosses
            what is inside — and the window takes the drop */}
        <label
          className={`${ready ? 'garment-pick has-photo' : 'garment-pick'}${dragging ? ' dragging' : ''}`}
          onDragOver={e => {
            if (Array.from(e.dataTransfer.types).includes('Files')) setDragging(true)
          }}
          onDragLeave={e => {
            if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragging(false)
          }}
        >
          <input
            type="file"
            accept="image/*"
            multiple
            className="garment-file"
            disabled={saving}
            onChange={e => {
              choose(e.target.files)
              e.target.value = ''
            }}
          />
          {ready ? (
            <img src={ready.preview} alt="The photo to save" />
          ) : busy || checking ? (
            <span className="garment-busy" role="status">
              <span className="garment-spinner" aria-hidden="true" />
              Getting the photo ready…
            </span>
          ) : (
            <>
              <Icon name="camera" size={28} />
              <span className="garment-pick-title">{file ? 'Choose another photo' : 'Choose photo'}</span>
              <small className="muted">or save the piece without one</small>
              <small className="muted garment-drop-hint">Drop or paste a photo here too</small>
            </>
          )}
        </label>
        {/* the back, for a shirt whose logo is there: optional, and only once the front is in */}
        {ready && (
          <div className="garment-add-back">
            {back.ready ? (
              <>
                <img src={back.ready.preview} alt="The back, to save" />
                <span className="garment-add-back-text">Back photo</span>
                <button type="button" className="btn subtle" disabled={saving} onClick={clearBack}>
                  Remove
                </button>
              </>
            ) : back.busy || checkingBack ? (
              <span className="garment-busy" role="status">
                <span className="garment-spinner" aria-hidden="true" />
                Getting the back ready…
              </span>
            ) : (
              <label className="toggle garment-back-pick">
                + Back photo
                <input
                  type="file"
                  accept="image/*"
                  className="garment-file"
                  disabled={saving}
                  onChange={e => {
                    const chosen = e.target.files?.[0]
                    e.target.value = ''
                    if (!chosen) return
                    setBackPicked(null)
                    setBackFile(chosen)
                  }}
                />
              </label>
            )}
          </div>
        )}
        {(error || back.error || failed) && (
          <p className="garment-error" role="alert">
            {error ?? back.error ?? failed}
          </p>
        )}
        <div className="field">
          <span>Type</span>
          <TypeChips type={type} onChange={setType} />
        </div>
        <div className="field">
          <span>Name</span>
          <div className="garment-names">
            {names.map(n => (
              <button key={n} type="button" className={name === n ? 'toggle on' : 'toggle'} onClick={() => setName(n)}>
                {n}
              </button>
            ))}
          </div>
          <input value={name} placeholder={names[0]} maxLength={80} aria-label="Name" onChange={e => setName(e.target.value)} />
        </div>
        <details className="garment-more">
          <summary>More</summary>
          <label className="field">
            <span>Notes</span>
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </label>
        </details>
      </div>
      <footer className="modal-foot">
        <span className="spacer" />
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={waiting} onClick={() => void save()}>
          Save
        </button>
      </footer>
      {/* over the sheet, not inside its panel, which would clip it */}
      {file &&
        checking &&
        createPortal(
          <Suspense fallback={null}>
            <CutoutSheet key={`${round}.${at}`} photo={file} onDone={(f, info) => setPicked({ file: f, cutout: info.cutout, offline: info.offline })} onCancel={skipPhoto} />
          </Suspense>,
          document.body,
        )}
      {backFile &&
        checkingBack &&
        createPortal(
          <Suspense fallback={null}>
            <CutoutSheet key={`back.${round}.${at}`} photo={backFile} onDone={(f, info) => setBackPicked({ file: f, cutout: info.cutout, offline: info.offline })} onCancel={() => setBackFile(null)} />
          </Suspense>,
          document.body,
        )}
    </Modal>
  )
}

function EditPiece({ id, garments, outfits, byId, ix, todayKey, userId, onEdit, onRetire, onDelete, onWearToday, onGoDay, onOpenPiece, onClose }: Props & { id: string }) {
  const g = garments.find(x => x.id === id)
  // edits after an await read the piece as it is by then, so each is stamped newer than the last
  const latest = useRef(g)
  latest.current = g
  const [draft, setDraft] = useState(g?.name ?? '')
  const [notes, setNotes] = useState(g?.notes ?? '')
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  /** Keeps what the details still have typed (the price, the tags), as the name and notes are kept. */
  const keepDetails = useRef(() => {})
  // a photo picked for either side goes through the cut-out sheet first, as an added one does
  const [checking, setChecking] = useState<{ file: File; side: Side } | null>(null)
  // gone from under the sheet (deleted, here or on another device): nothing left to show
  useEffect(() => {
    if (!g) onClose()
  }, [g, onClose])
  if (!g) return null

  const edit = (change: (cur: Garment) => Garment, msg?: string) => {
    const cur = latest.current
    if (cur) onEdit(cur, change(cur), msg)
  }
  const commitName = () => {
    const cur = latest.current
    if (!cur || draft.trim() === cur.name) return
    const next = renamed(cur, draft)
    onEdit(cur, next)
    setDraft(next.name)
  }
  const commitNotes = () => {
    const cur = latest.current
    const text = notes.trim().slice(0, 500)
    if (!cur || text === (cur.notes ?? '')) return
    onEdit(cur, { ...cur, notes: text || undefined, updatedAt: newerStamp(cur.updatedAt) })
  }
  /** A photo for one side, made ready and filed: a front replaces the front (and its colour); a back is added, or replaces the back. */
  const replace = async (file: File, cutout: boolean, offline?: boolean, side: Side = 'front') => {
    setChecking(null)
    setPhotoBusy(true)
    setPhotoError(null)
    try {
      const p = await prepareGarmentPhoto(file, { cutout })
      const ids = await fileAway(p, userId)
      // the old ones go once these are up and the Undo has had its time, and
      // only if no piece points at them by then (Wardrobe → retireMedia):
      // deleted at once, an Undo or another device's copy would point at nothing
      if (side === 'back') edit(cur => withBack(cur, ids), latest.current && hasBack(latest.current) ? 'Back photo replaced' : 'Back photo added')
      else edit(cur => ({ ...cur, photoId: ids.photoId, thumbId: ids.thumbId, color: p.color ?? cur.color, updatedAt: newerStamp(cur.updatedAt) }), 'Photo replaced')
      if (offline) keptOffline(ids.photoId)
    } catch (err) {
      setPhotoError(failure(err))
    } finally {
      setPhotoBusy(false)
    }
  }
  const close = () => {
    commitName()
    commitNotes()
    keepDetails.current()
    onClose()
  }
  /** A file picked for a side: to the cut-out sheet with it. */
  const pickFor = (side: Side) => (e: { target: HTMLInputElement }) => {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (picked) setChecking({ file: picked, side })
  }

  const stats = garmentStats(g, ix)
  const cost = costLine(g, ix)
  const wornOn = (ix.days.get(g.id) ?? []).slice(0, 10)
  const inOutfits = outfits.filter(o => !o.deletedAt && o.garmentIds.includes(g.id))
  const back = hasBack(g)

  return (
    <Modal onClose={close} className="modal narrow garment-sheet">
      <ModalHead title={g.name}>
        <button
          type="button"
          aria-pressed={!!g.favourite}
          aria-label="Favourite"
          title={g.favourite ? 'A favourite — tap to unstar it' : 'Star it as a favourite'}
          className={g.favourite ? 'btn subtle garment-fav on' : 'btn subtle garment-fav'}
          onClick={() => edit(cur => starred(cur, !cur.favourite))}
        >
          <Icon name="star" size={18} filled={!!g.favourite} />
        </button>
      </ModalHead>
      <div className="modal-body">
        <div className="garment-hero">
          {/* keyed by the side it leads with, so Show the back first shows at once */}
          <GarmentView key={mainSide(g)} garment={g} size="photo" alt={g.name} flip />
          {photoBusy && (
            <span className="garment-busy" role="status">
              <span className="garment-spinner" aria-hidden="true" />
              Getting the photo ready…
            </span>
          )}
        </div>
        {/* the back, for a piece whose logo or print is there: once it has a front */}
        {(g.photoId || g.thumbId) && (
          <div className="garment-back" role="group" aria-label="Back photo">
            <label className="btn subtle garment-back-pick">
              {back ? 'Replace back photo' : 'Add back photo'}
              <input type="file" accept="image/*" className="garment-file" disabled={photoBusy} onChange={pickFor('back')} />
            </label>
            {back && (
              <>
                <button type="button" className="btn subtle" disabled={photoBusy} onClick={() => edit(cur => withBack(cur, null), 'Back photo removed')}>
                  Remove back photo
                </button>
                <CutoutLater garment={g} side="back" disabled={photoBusy} onCutout={file => void replace(file, true, false, 'back')} onError={setPhotoError} />
                <label className="garment-back-first">
                  <input type="checkbox" role="switch" checked={!!g.showBack} onChange={e => edit(cur => showingBack(cur, e.target.checked))} />
                  Show the back first
                </label>
              </>
            )}
          </div>
        )}
        {photoError && (
          <p className="garment-error" role="alert">
            {photoError}
          </p>
        )}
        <div className="garment-figures">
          <p className="garment-worn">
            {wornLine(ix, g.id)}
            {g.archivedAt && <span className="badge wardrobe-retired">Retired</span>}
          </p>
          {stats.firstWorn && (
            <p className="garment-sub">
              First worn {shortDay(stats.firstWorn, todayKey)} · 30 days: {stats.in30} · 12 months: {stats.in365}
            </p>
          )}
          {cost && <p className="garment-sub">{cost}</p>}
          <Bars weekly={stats.weekly} color={g.color ?? 'var(--accent)'} title="Days worn per week, last 12 weeks" />
        </div>
        <label className="field">
          <span>Name</span>
          <input
            value={draft}
            maxLength={80}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitName()
              }
            }}
          />
        </label>
        <div className="field">
          <span>Type</span>
          <TypeChips type={g.type} onChange={t => t !== g.type && edit(cur => ({ ...cur, type: t, updatedAt: newerStamp(cur.updatedAt) }))} />
        </div>
        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} onBlur={commitNotes} />
        </label>
        <PieceDetails
          garment={g}
          ix={ix}
          byId={byId}
          onEdit={edit}
          onOpenPiece={other => {
            commitName()
            commitNotes()
            keepDetails.current()
            onOpenPiece(other)
          }}
          keep={keepDetails}
        />
        {wornOn.length > 0 && (
          <div className="field">
            <span>Worn on</span>
            <div className="garment-days">
              {wornOn.map(d => (
                <button
                  key={d}
                  type="button"
                  className="toggle"
                  onClick={() => {
                    commitName()
                    commitNotes()
                    keepDetails.current()
                    onGoDay(d)
                  }}
                >
                  {shortDay(d, todayKey)}
                </button>
              ))}
            </div>
          </div>
        )}
        {inOutfits.length > 0 && (
          <div className="field">
            <span>In outfits</span>
            <ul className="garment-outfits">
              {inOutfits.map(o => (
                <li key={o.id}>{o.name || outfitLabel(o.garmentIds, byId)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <footer className="modal-foot garment-actions">
        <ConfirmButton className="btn subtle danger" onConfirm={() => onDelete(g)}>
          Delete
        </ConfirmButton>
        <button type="button" className="btn subtle" onClick={() => onRetire(g, !g.archivedAt)}>
          {g.archivedAt ? 'Bring back' : 'Retire'}
        </button>
        <label className="btn subtle garment-replace">
          Replace photo
          <input type="file" accept="image/*" className="garment-file" disabled={photoBusy} onChange={pickFor('front')} />
        </label>
        <CutoutLater garment={g} disabled={photoBusy} onCutout={file => void replace(file, true)} onError={setPhotoError} />
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={!!g.archivedAt} onClick={() => onWearToday(g)}>
          Wear today
        </button>
      </footer>
      {checking &&
        createPortal(
          <Suspense fallback={null}>
            <CutoutSheet photo={checking.file} onDone={(f, info) => void replace(f, info.cutout, info.offline, checking.side)} onCancel={() => setChecking(null)} />
          </Suspense>,
          document.body,
        )}
    </Modal>
  )
}
