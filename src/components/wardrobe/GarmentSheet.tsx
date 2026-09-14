import { useEffect, useRef, useState } from 'react'
import { newerStamp } from '../../itemops'
import { shortDay } from '../../kitchen'
import { saveMedia } from '../../media'
import { PhotoUnreadable, prepareGarmentPhoto } from '../../photo'
import { GARMENT_TYPES, GARMENT_TYPE_META, type Garment, type GarmentType, type Outfit } from '../../types'
import { uid } from '../../utils'
import { garmentStats, outfitLabel, renamed, suggestedNames, wornLine, type WearIndex } from '../../wardrobe'
import { Bars } from '../bits'
import { ConfirmButton } from '../ConfirmButton'
import { Icon } from '../Icon'
import { Modal, ModalHead } from '../Modal'
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

const failure = (err: unknown) => (err instanceof PhotoUnreadable ? err.message : 'That photo could not be kept on this device — try again')

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

type Ready = { photo: Blob; thumb: Blob; color?: string; preview: string }

/** A picked photo made ready — decoded once, sized twice, its colour sampled — with a preview URL let go when it goes. */
function usePrepared(file: File | null): { ready: Ready | null; busy: boolean; error: string | null } {
  const [done, setDone] = useState<{ file: File; ready: Ready | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!file) return
    let live = true
    let preview: string | null = null
    prepareGarmentPhoto(file).then(
      p => {
        preview = URL.createObjectURL(p.photo)
        if (live) setDone({ file, ready: { ...p, preview }, error: null })
        else URL.revokeObjectURL(preview)
      },
      err => {
        if (live) setDone({ file, ready: null, error: failure(err) })
      },
    )
    return () => {
      live = false
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [file])
  const current = done !== null && done.file === file
  return { ready: current ? done.ready : null, busy: !!file && !current, error: current ? done.error : null }
}

/** The piece sheet: add one (or a queue of them from several photos), or everything about one. */
export function GarmentSheet(props: Props) {
  const { mode } = props
  return mode.kind === 'add' ? <AddPiece preset={mode.type} onCreate={props.onCreate} onClose={props.onClose} /> : <EditPiece {...props} id={mode.id} />
}

function AddPiece({ preset, onCreate, onClose }: { preset?: GarmentType; onCreate(g: Garment): void; onClose(): void }) {
  const [queue, setQueue] = useState<File[]>([])
  const [at, setAt] = useState(0)
  const file = queue[at] ?? null
  const { ready, busy, error } = usePrepared(file)
  const [lastSaved, setLastSaved] = useState<GarmentType | null>(null)
  const [type, setType] = useState<GarmentType>(preset ?? 'top')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const names = suggestedNames(type, ready?.color)

  const choose = (files: FileList | null) => {
    const picked = Array.from(files ?? [])
    if (picked.length === 0) return
    setQueue(picked)
    setAt(0)
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
    setName('')
    setNotes('')
    setFailed(null)
    setType(preset ?? saved ?? lastSaved ?? 'top')
  }
  const save = async () => {
    if (saving || busy || (file && !ready)) return
    setSaving(true)
    try {
      // the two photos go into this device's store, and its upload queue, first; the piece then points at them
      const photoId = ready ? await saveMedia(ready.photo, { personal: true }) : undefined
      const thumbId = ready ? await saveMedia(ready.thumb, { personal: true }) : undefined
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
          ) : busy ? (
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
    </Modal>
  )
}

function EditPiece({ id, garments, outfits, byId, ix, todayKey, onEdit, onRetire, onDelete, onWearToday, onGoDay, onClose }: Props & { id: string }) {
  const g = garments.find(x => x.id === id)
  // edits after an await read the piece as it is by then, so each is stamped newer than the last
  const latest = useRef(g)
  latest.current = g
  const [draft, setDraft] = useState(g?.name ?? '')
  const [notes, setNotes] = useState(g?.notes ?? '')
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
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
  const replace = async (file: File | undefined) => {
    if (!file) return
    setPhotoBusy(true)
    setPhotoError(null)
    try {
      const p = await prepareGarmentPhoto(file)
      const photoId = await saveMedia(p.photo, { personal: true })
      const thumbId = await saveMedia(p.thumb, { personal: true })
      // the old two stay where they are: an orphan is safer than a reference
      // that another device's edit of the piece could lose in a merge
      edit(cur => ({ ...cur, photoId, thumbId, color: p.color ?? cur.color, updatedAt: newerStamp(cur.updatedAt) }), 'Photo replaced')
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
              void replace(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={!!g.archivedAt} onClick={() => onWearToday(g)}>
          Wear today
        </button>
      </footer>
    </Modal>
  )
}
