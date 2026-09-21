import { useEffect, useRef, useState } from 'react'
import { householdAction } from '../../household'
import { deleteMedia, imageFiles, saveMedia } from '../../media'
import { getSupabase } from '../../supabase'
import { MemberFace } from '../MemberFace'
import type { SettingsCtx } from './context'
import { useAsyncAction } from './useAsyncAction'

// You: the three things about yourself you might actually want to change —
// your picture, the name the household sees, and your password. They used to
// be in three different places or in none: the name was one field buried under
// Household, the password could only be reset by whoever holds Admin, and
// there was no picture at all, so every surface that had to draw you took the
// first two letters of your name.

/** The longest side a picture is kept at. A face in a 28px circle needs no more, and it has to sync. */
const FACE_PX = 512
/** Supabase's own floor. Saying so beforehand beats a server error after the tap. */
const MIN_PASSWORD = 8

/**
 * Square, downscaled and re-encoded as JPEG. A phone photo is several
 * megabytes of a scene the app draws at 28 pixels across; uploading that
 * whole would cost the other member's device a slow first paint for nothing.
 * Falls back to the file as picked if the canvas is unavailable.
 */
async function toFace(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const side = Math.min(bitmap.width, bitmap.height)
    const size = Math.min(side, FACE_PX)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    // centre crop: a face is usually in the middle of the frame, and a circle shows the middle anyway
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
    bitmap.close?.()
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return blob ?? file
  } catch {
    return file
  }
}

/** Settings → You: your picture, your name, and your password. */
export function Profile({ household, supabaseOn }: SettingsCtx) {
  const me = household.info?.me
  const [name, setName] = useState(me?.displayName ?? '')
  const [email, setEmail] = useState('')
  const [touched, setTouched] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const { busy, error, run, setError } = useAsyncAction()
  const [saved, setSaved] = useState('')

  // the name the server knows, until you start typing over it: a refresh
  // after another device saved one must not wipe what is in the box here
  useEffect(() => {
    if (!touched) setName(me?.displayName ?? '')
  }, [me?.displayName, touched])

  useEffect(() => {
    getSupabase()
      ?.auth.getSession()
      .then(({ data }) => setEmail(data.session?.user.email ?? ''))
  }, [])

  const say = (words: string) => {
    setSaved(words)
    window.setTimeout(() => setSaved(s => (s === words ? '' : s)), 4000)
  }

  const saveName = () =>
    run(async () => {
      await householdAction('me', { displayName: name.trim() })
      await household.refresh()
      setTouched(false)
      say('Name saved')
    })

  const pickFace = (files: FileList | null) => {
    const [picked] = imageFiles(files ?? [])
    if (!picked) return
    void run(async () => {
      // a bare id, not personal/: the picture exists to be seen by the other
      // member, and the personal/ folder is exactly what they cannot read
      const id = await saveMedia(await toFace(picked), {})
      const old = me?.avatar
      await householdAction('me', { avatar: id })
      await household.refresh()
      // the replaced one is nobody's now; a failure here costs a stray object, never the new face
      if (old) await deleteMedia([old]).catch(() => {})
      say('Picture saved')
    })
  }

  const clearFace = () =>
    run(async () => {
      const old = me?.avatar
      await householdAction('me', { avatar: null })
      await household.refresh()
      if (old) await deleteMedia([old]).catch(() => {})
      say('Back to your initials')
    })

  if (!supabaseOn) return null
  return (
    <section className="settings-section g-you">
      <h3>You</h3>
      <div className="profile-row">
        <MemberFace name={name || email || 'You'} avatar={me?.avatar} id={me?.id} size={72} className="profile-face" />
        <div className="profile-face-actions">
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={e => {
              pickFace(e.target.files)
              e.target.value = ''
            }}
          />
          <button type="button" className="btn" disabled={busy} onClick={() => file.current?.click()}>
            {me?.avatar ? 'Change picture' : 'Add a picture'}
          </button>
          {me?.avatar && (
            <button type="button" className="btn subtle" disabled={busy} onClick={clearFace}>
              Remove
            </button>
          )}
          <p className="field-hint">Squared off and shrunk before it goes up. The household sees it; nobody else can.</p>
        </div>
      </div>

      <label className="field">
        <span>Your name</span>
        <input
          value={name}
          placeholder="The name the household sees"
          onChange={e => {
            setTouched(true)
            setName(e.target.value)
          }}
        />
      </label>
      <div className="check-add">
        <button className="btn primary" disabled={busy || name.trim() === (me?.displayName ?? '')} onClick={saveName}>
          Save name
        </button>
        {email && <small className="muted">Signed in as {email}</small>}
      </div>

      <PasswordFields busy={busy} run={run} setError={setError} say={say} />

      {saved && <p className="sync-ok">{saved}</p>}
      {(error || household.error) && <p className="warn">{error || household.error}</p>}
    </section>
  )
}

/**
 * Change your own password, without anyone else being involved. Supabase takes
 * a new password on the session that is already signed in, so there is no old
 * password to type and no email round trip; the second box is there because a
 * typo in the only box would lock this account out of every device.
 */
function PasswordFields({
  busy,
  run,
  setError,
  say,
}: {
  busy: boolean
  run(fn: () => Promise<unknown>): Promise<boolean>
  setError(words: string): void
  say(words: string): void
}) {
  const [open, setOpen] = useState(false)
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')

  const save = () => {
    if (next.length < MIN_PASSWORD) return setError(`A password needs at least ${MIN_PASSWORD} characters.`)
    if (next !== again) return setError('Those two do not match.')
    void run(async () => {
      const sb = getSupabase()
      if (!sb) throw new Error('This copy of Drafter has no account to change.')
      const { error } = await sb.auth.updateUser({ password: next })
      if (error) throw new Error(error.message)
      setNext('')
      setAgain('')
      setOpen(false)
      say('Password changed')
    })
  }

  if (!open) {
    return (
      <p className="sync-line">
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Change your password
        </button>
        <small className="muted">You are signed in, so there is nothing to type but the new one.</small>
      </p>
    )
  }
  return (
    <div className="profile-password">
      <label className="field">
        <span>New password</span>
        <input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
      </label>
      <label className="field">
        <span>Again</span>
        <input type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} />
      </label>
      <div className="check-add">
        <button className="btn primary" disabled={busy || !next || !again} onClick={save}>
          Save password
        </button>
        <button
          className="btn subtle"
          disabled={busy}
          onClick={() => {
            setOpen(false)
            setNext('')
            setAgain('')
            setError('')
          }}
        >
          Cancel
        </button>
      </div>
      <p className="field-hint">Changing it here signs nothing else out: your other devices keep working.</p>
    </div>
  )
}
