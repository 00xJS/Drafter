import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Metrics,
  Platform,
  PLATFORMS,
  PLATFORM_META,
  Post,
  RECURRENCE_META,
  RecurrenceFreq,
  Status,
  STATUSES,
  STATUS_META,
} from '../types'
import { newerStamp } from '../postops'
import { fromLocalInput, toLocalInput, uid } from '../utils'
import { mediaURL, saveMedia } from '../media'
import { generateVariants, suggestTags } from '../ai'

interface Props {
  post?: Post
  preset?: Partial<Post>
  /** The freshest copy in the store — save() merges onto it so fields the user
   *  did NOT touch keep concurrent edits (e.g. a bot logging metrics). */
  getLatest(id: string): Post | undefined
  onSave(p: Post): void
  onDelete(id: string): void
  onClose(): void
}

const METRIC_FIELDS: (keyof Metrics)[] = ['likes', 'comments', 'shares', 'impressions']

export function Composer({ post, preset, getLatest, onSave, onDelete, onClose }: Props) {
  const [base] = useState<Post>(() => {
    const now = new Date().toISOString()
    return (
      post ?? {
        id: uid(),
        title: '',
        body: '',
        platforms: ['x'],
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        tags: [],
        ...preset,
      }
    )
  })

  const [title, setTitle] = useState(base.title)
  const [body, setBody] = useState(base.body)
  const [platforms, setPlatforms] = useState<Platform[]>(base.platforms)
  const [status, setStatus] = useState<Status>(base.status)
  const [scheduledFor, setScheduledFor] = useState(toLocalInput(base.scheduledFor))
  const [postedAt, setPostedAt] = useState(toLocalInput(base.postedAt))
  const [tags, setTags] = useState(base.tags.join(', '))
  const [notes, setNotes] = useState(base.notes ?? '')
  const [link, setLink] = useState(base.link ?? '')
  const [metrics, setMetrics] = useState<NonNullable<Post['metrics']>>(base.metrics ?? {})
  const [variants, setVariants] = useState<NonNullable<Post['variants']>>(base.variants ?? {})
  const [freq, setFreq] = useState<RecurrenceFreq | ''>(base.recurrence?.freq ?? '')
  const [mediaIds, setMediaIds] = useState<string[]>(base.mediaIds ?? [])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [aiBusy, setAiBusy] = useState<'variants' | 'tags' | null>(null)
  const [aiError, setAiError] = useState('')
  const mediaInput = useRef<HTMLInputElement>(null)
  const finePointer = useMemo(() => window.matchMedia('(pointer: fine)').matches, [])

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

  const togglePlatform = (pl: Platform) =>
    setPlatforms(cur => (cur.includes(pl) ? cur.filter(x => x !== pl) : [...cur, pl]))

  const setMetric = (pl: Platform, field: keyof Metrics, value: string) =>
    setMetrics(cur => ({
      ...cur,
      [pl]: { ...cur[pl], [field]: value === '' ? undefined : Number(value) },
    }))

  const effectiveLength = (pl: Platform) => {
    const v = variants[pl]
    return v && v.trim() ? v.length : body.length
  }

  async function addMedia(files: FileList | null) {
    if (!files) return
    const ids: string[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      ids.push(await saveMedia(file))
    }
    if (ids.length > 0) setMediaIds(cur => [...cur, ...ids])
  }

  async function aiVariants() {
    setAiError('')
    setAiBusy('variants')
    try {
      const generated = await generateVariants(body, platforms)
      setVariants(cur => ({ ...cur, ...generated }))
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAiBusy(null)
    }
  }

  async function aiTags() {
    setAiError('')
    setAiBusy('tags')
    try {
      const suggested = await suggestTags(body)
      const existing = tags
        .split(',')
        .map(t => t.trim().replace(/^#/, ''))
        .filter(Boolean)
      const merged = [...existing, ...suggested.filter(t => !existing.includes(t))]
      setTags(merged.join(', '))
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAiBusy(null)
    }
  }

  /** The form's current value for every editable field, in Post shape. */
  function formValues() {
    const cleanVariants: NonNullable<Post['variants']> = {}
    for (const pl of platforms) {
      const v = variants[pl]
      if (v && v.trim()) cleanVariants[pl] = v
    }
    return {
      title: title.trim(),
      body,
      platforms,
      status,
      scheduledFor: fromLocalInput(scheduledFor),
      postedAt: fromLocalInput(postedAt),
      tags: tags
        .split(',')
        .map(t => t.trim().replace(/^#/, ''))
        .filter(Boolean),
      notes: notes.trim() || undefined,
      link: link.trim() || undefined,
      metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
      variants: Object.keys(cleanVariants).length > 0 ? cleanVariants : undefined,
      mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
      recurrence: freq ? ({ freq } as Post['recurrence']) : undefined,
    }
  }

  function baseValues() {
    return {
      title: base.title,
      body: base.body,
      platforms: base.platforms,
      status: base.status,
      scheduledFor: base.scheduledFor,
      postedAt: base.postedAt,
      tags: base.tags,
      notes: base.notes,
      link: base.link,
      metrics: base.metrics,
      variants: base.variants,
      mediaIds: base.mediaIds,
      recurrence: base.recurrence,
    }
  }

  const isDirty = () => JSON.stringify(formValues()) !== JSON.stringify(baseValues())

  function requestClose() {
    if (isDirty() && !window.confirm('Discard your changes?')) return
    onClose()
  }

  function save() {
    // merge only the fields the user changed onto the FRESHEST copy, so
    // concurrent updates (a bot logging metrics, an edit on another device)
    // survive an open composer
    const current = getLatest(base.id) ?? base
    const form = formValues()
    const was = baseValues()
    const next: Post = { ...current }
    for (const key of Object.keys(form) as (keyof typeof form)[]) {
      if (JSON.stringify(form[key]) !== JSON.stringify(was[key])) {
        ;(next as Record<string, unknown>)[key] = form[key]
      }
    }
    if (next.status === 'posted') next.postedAt = next.postedAt ?? next.scheduledFor ?? new Date().toISOString()
    else next.postedAt = undefined
    next.updatedAt = newerStamp(current.updatedAt)
    onSave(next)
  }

  const overLimit = platforms.filter(pl => effectiveLength(pl) > PLATFORM_META[pl].charLimit)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>{post ? 'Edit post' : 'New post'}</h2>
          <button className="btn primary modal-head-save" onClick={save}>
            Save
          </button>
          <button className="btn subtle" onClick={requestClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <label className="field">
            <span>
              Title <small>(internal — not published)</small>
            </span>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Feature launch teaser"
              autoFocus={!post && finePointer}
            />
          </label>

          <label className="field">
            <span>Content</span>
            <textarea rows={6} value={body} onChange={e => setBody(e.target.value)} placeholder="Write the post…" />
            <div className="char-counts">
              <span className="char-total">{body.length} characters</span>
              {platforms.map(pl => {
                const left = PLATFORM_META[pl].charLimit - effectiveLength(pl)
                return (
                  <span key={pl} className={left < 0 ? 'char-chip over' : 'char-chip'}>
                    {PLATFORM_META[pl].short}: {left < 0 ? `${-left} over` : `${left} left`}
                  </span>
                )
              })}
            </div>
          </label>

          <div className="field">
            <span>Platforms</span>
            <div className="platform-toggles">
              {PLATFORMS.map(pl => (
                <button
                  key={pl}
                  type="button"
                  className={platforms.includes(pl) ? 'toggle on' : 'toggle'}
                  onClick={() => togglePlatform(pl)}
                >
                  {PLATFORM_META[pl].label}
                </button>
              ))}
            </div>
          </div>

          {platforms.length > 0 && (
            <div className="field">
              <span>
                Per-platform overrides <small>(blank uses the main content)</small>
              </span>
              <div className="variant-list">
                {platforms.map(pl => (
                  <details key={pl} className="variant" open={!!variants[pl]?.trim()}>
                    <summary>
                      {PLATFORM_META[pl].label}
                      {variants[pl]?.trim() ? <em> — customized</em> : null}
                    </summary>
                    <textarea
                      rows={3}
                      value={variants[pl] ?? ''}
                      onChange={e => setVariants(cur => ({ ...cur, [pl]: e.target.value }))}
                      placeholder="Uses main content"
                    />
                  </details>
                ))}
              </div>
              <div className="ai-row">
                <button type="button" className="btn" disabled={!body.trim() || aiBusy !== null} onClick={aiVariants}>
                  {aiBusy === 'variants' ? 'Generating…' : '✨ Generate platform variants'}
                </button>
                <button type="button" className="btn" disabled={!body.trim() || aiBusy !== null} onClick={aiTags}>
                  {aiBusy === 'tags' ? 'Suggesting…' : '✨ Suggest tags'}
                </button>
                {aiError && <span className="warn">{aiError}</span>}
              </div>
            </div>
          )}

          <div className="field">
            <span>Media</span>
            <div className="media-grid">
              {mediaIds.map(id => (
                <span key={id} className="media-thumb">
                  {thumbs[id] ? <img src={thumbs[id]} alt="" /> : <span className="media-missing">?</span>}
                  <button
                    type="button"
                    className="media-remove"
                    aria-label="Remove image"
                    onClick={() => setMediaIds(cur => cur.filter(x => x !== id))}
                  >
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

          <div className="field-row">
            <div className="field">
              <span>Status</span>
              <div className="segmented">
                {STATUSES.map(s => (
                  <button key={s} type="button" className={status === s ? 'seg on' : 'seg'} onClick={() => setStatus(s)}>
                    {STATUS_META[s].label}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>Repeat</span>
              <select value={freq} onChange={e => setFreq(e.target.value as RecurrenceFreq | '')}>
                <option value="">Doesn’t repeat</option>
                {(Object.keys(RECURRENCE_META) as RecurrenceFreq[]).map(f => (
                  <option key={f} value={f}>
                    {RECURRENCE_META[f]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {freq && (
            <p className="field-hint">When this is marked posted, the next occurrence is created automatically.</p>
          )}

          {status === 'scheduled' && (
            <label className="field">
              <span>Scheduled for</span>
              <input type="datetime-local" value={scheduledFor} onChange={e => setScheduledFor(e.target.value)} />
            </label>
          )}

          {status === 'posted' && (
            <>
              <label className="field">
                <span>Posted at</span>
                <input type="datetime-local" value={postedAt} onChange={e => setPostedAt(e.target.value)} />
              </label>
              <div className="field">
                <span>
                  Results per platform <small>(fill in what you have)</small>
                </span>
                {platforms.map(pl => (
                  <div key={pl} className="metrics-row">
                    <span className="metrics-platform">{PLATFORM_META[pl].label}</span>
                    {METRIC_FIELDS.map(f => (
                      <label key={f} className="metric-input">
                        <small>{f}</small>
                        <input
                          type="number"
                          min={0}
                          value={metrics[pl]?.[f] ?? ''}
                          onChange={e => setMetric(pl, f, e.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="field-row">
            <label className="field">
              <span>
                Tags <small>(comma-separated)</small>
              </span>
              <input value={tags} onChange={e => setTags(e.target.value)} placeholder="launch, tips" />
            </label>
            <label className="field">
              <span>Link</span>
              <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://…" />
            </label>
          </div>

          <label className="field">
            <span>Notes</span>
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ideas, assets to prepare, approvals…" />
          </label>
        </div>

        <footer className="modal-foot">
          {post && (
            <button className="btn danger" onClick={() => onDelete(post.id)}>
              Delete
            </button>
          )}
          <span className="spacer" />
          {overLimit.length > 0 && (
            <span className="warn">Over the limit for {overLimit.map(pl => PLATFORM_META[pl].short).join(', ')}</span>
          )}
          <button className="btn" onClick={requestClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}
