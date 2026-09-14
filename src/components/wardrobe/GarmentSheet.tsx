import { Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { newerStamp } from '../../itemops'
import { shortDay } from '../../kitchen'
import { preloadable, warm } from '../../lazyload'
import { NotSignedIn, saveMedia } from '../../media'
import { PhotoUnreadable, prepareGarmentPhoto } from '../../photo'
import { GARMENT_TYPES, GARMENT_TYPE_META, type Garment, type GarmentType, type Outfit } from '../../types'
import { uid } from '../../utils'
import { garmentStats, outfitLabel, renamed, suggestedNames, wornLine, type WearIndex } from '../../wardrobe'
import { Bars } from '../bits'
import { ConfirmButton } from '../ConfirmButton'
import { Icon } from '../Icon'
import { Modal, ModalHead } from '../Modal'
import { CutoutLater, keptOffline } from './CutoutLater'
import { GarmentPhoto } from './GarmentPhoto'

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
  const [lastSaved, setLastSaved] = useState<GarmentType | null>(null)
  const [type, setType] = useState<GarmentType>(preset ?? 'top')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const names = suggestedNames(type, ready?.color)

  useEffect(warmCutout, [])

  const choose = (files: FileList | null) => {
    const chosen = Array.from(files ?? [])
    if (chosen.length === 0) return
    setQueue(chosen)
    setAt(0)
    setRound(r => r + 1)
    setPicked(null)
    setName('')
    setNotes('')
    setFailed(null)
  }
  /** On to the next photo picked (typed as the way in said, else as the last one saved), or done. */
  const next = (saved?: GarmentType) => {
    if (at + 1 >= queue.length) {
      onClose()
      return
    }
    setAt(at + 1)
    setPicked(null)
    setName('')
    setNotes('')
    setFailed(null)
    setType(preset ?? saved ?? lastSaved ?? 'top')
  }
  /** The cut-out sheet closed without a choice: that photo is not used, and the next one picked comes up, or the picker again. */
  const drop = () => {
    setPicked(null)
    if (at + 1 < queue.length) setAt(at + 1)
    else {
      setQueue([])
      setAt(0)
    }
  }
  const save = async () => {
    if (saving || busy || (file && !ready)) return
    setSaving(true)
    try {
      // the two photos go into this device's store, and its upload queue, first; the piece then points at them
      const photoId = ready ? await saveMedia(ready.photo, { personal: true, userId }) : undefined
      const thumbId = ready ? await saveMedia(ready.thumb, { personal: true, userId }) : undefined
      const now = new Date().toISOString()
      onCreate({
        kind: 'garment',
        id: uid(),
        name: name.trim().slice(0, 80) || names[0],
        type,
        photoId,
        thumbId,
        color: ready?.color,
        notes: notes.trim().slice(0, 500) || undefined,
        createdAt: now,
        updatedAt: now,
      })
      // kept as it was only for want of a connection: its sheet offers Cut out now once online
      if (photoId && picked?.offline) keptOffline(photoId)
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
    if (ready && !window.confirm('Discard this photo?')) return
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
            iPhone, Take Photo, Photo Library or Choose File */}
        <label className={ready ? 'garment-pick has-photo' : 'garment-pick'}>
          <input
            type="file"
            accept="image/*"
            multiple
            className="garment-file"
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
            </>
          )}
        </label>
        {(error || failed) && (
          <p className="garment-error" role="alert">
            {error ?? failed}
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
        <button type="button" className="btn primary" disabled={saving || busy || (!!file && !ready)} onClick={() => void save()}>
          Save
        </button>
      </footer>
      {/* over the sheet, not inside its panel, which would clip it */}
      {file &&
        checking &&
        createPortal(
          <Suspense fallback={null}>
            <CutoutSheet key={`${round}.${at}`} photo={file} onDone={(f, info) => setPicked({ file: f, cutout: info.cutout, offline: info.offline })} onCancel={drop} />
          </Suspense>,
          document.body,
        )}
    </Modal>
  )
}

function EditPiece({ id, garments, outfits, byId, ix, todayKey, userId, onEdit, onRetire, onDelete, onWearToday, onGoDay, onClose }: Props & { id: string }) {
  const g = garments.find(x => x.id === id)
  // edits after an await read the piece as it is by then, so each is stamped newer than the last
  const latest = useRef(g)
  latest.current = g
  const [draft, setDraft] = useState(g?.name ?? '')
  const [notes, setNotes] = useState(g?.notes ?? '')
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  // a replacement photo goes through the cut-out sheet first, as an added one does
  const [checking, setChecking] = useState<File | null>(null)
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
  const replace = async (file: File, cutout: boolean, offline?: boolean) => {
    setChecking(null)
    setPhotoBusy(true)
    setPhotoError(null)
    try {
      const p = await prepareGarmentPhoto(file, { cutout })
      const photoId = await saveMedia(p.photo, { personal: true, userId })
      const thumbId = await saveMedia(p.thumb, { personal: true, userId })
      // the old two stay where they are: an orphan is safer than a reference
      // that another device's edit of the piece could lose in a merge
      edit(cur => ({ ...cur, photoId, thumbId, color: p.color ?? cur.color, updatedAt: newerStamp(cur.updatedAt) }), 'Photo replaced')
      if (offline) keptOffline(photoId)
    } catch (err) {
      setPhotoError(failure(err))
    } finally {
      setPhotoBusy(false)
    }
  }
  const close = () => {
    commitName()
    commitNotes()
    onClose()
  }

  const stats = garmentStats(g, ix)
  const wornOn = (ix.days.get(g.id) ?? []).slice(0, 10)
  const inOutfits = outfits.filter(o => !o.deletedAt && o.garmentIds.includes(g.id))

  return (
    <Modal onClose={close} className="modal narrow garment-sheet">
      <ModalHead title={g.name} />
      <div className="modal-body">
        <div className="garment-hero">
          <GarmentPhoto garment={g} size="photo" alt={g.name} />
          {photoBusy && (
            <span className="garment-busy" role="status">
              <span className="garment-spinner" aria-hidden="true" />
              Getting the photo ready…
            </span>
          )}
        </div>
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
          <input
            type="file"
            accept="image/*"
            className="garment-file"
            disabled={photoBusy}
            onChange={e => {
              const picked = e.target.files?.[0]
              e.target.value = ''
              if (picked) setChecking(picked)
            }}
          />
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
            <CutoutSheet photo={checking} onDone={(f, info) => void replace(f, info.cutout, info.offline)} onCancel={() => setChecking(null)} />
          </Suspense>,
          document.body,
        )}
    </Modal>
  )
}
