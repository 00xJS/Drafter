import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { JournalEntry, MOODS, MOOD_META, Mood, Person } from '../types'
import { newerStamp } from '../itemops'
import { useDayKey } from '../useDayKey'
import { JournalDraft, draftOf, entryOn, faceGroup, idSet, mergeDraft, newEntry, peopleOf, samePeople, shiftDayKey, streak } from '../journal'
import { excerpt } from '../utils'
import { haptic } from '../native'
import { useMediaQuery } from '../useMediaQuery'
import { ConfirmButton } from './ConfirmButton'
import { useFold } from './HomeFold'

// Writing a day down: Today's card, and the editor it writes with, which the
// journal page, the evening shutdown and the weekly review use too. Today draws
// this at launch; the archive the Insights tab reads back (Journal.tsx, with its
// mood chart and search) loads only when that tab is opened.

/** How long after the last keystroke an entry is written. Blur and unmount write at once. */
const SAVE_DELAY = 700

/**
 * Small round faces for the people an entry names (Today does the same for
 * occasions). On a phone at most three faces are drawn, then a `+N` chip: the
 * day header they sit in is a single row on a 375pt screen, and a whole
 * household of faces pushes its Edit button off the clipped page. Desktop has
 * the width, so it keeps every face. `role="img"` makes the label authoritative
 * — a bare span is `generic`, a role that may not be named, so the roster would
 * be dropped and the faces read one by one instead.
 */
export function JournalPeople({ entry, people }: { entry: Pick<JournalEntry, 'peopleIds'>; people: Person[] }) {
  const narrow = useMediaQuery('(max-width: 640px)')
  const who = peopleOf(entry, people)
  if (who.length === 0) return null
  const { shown, extra } = faceGroup(who, narrow ? 3 : who.length)
  return (
    <span className="journal-avatars" role="img" aria-label={`With ${who.map(p => p.name).join(', ')}`}>
      {shown.map(p => (
        <span key={p.id} className="person-avatar small" style={{ background: p.color }} title={p.name}>
          {p.emoji ?? p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {extra > 0 && (
        <span className="person-avatar small more" title={who.slice(shown.length).map(p => p.name).join(', ')}>
          +{extra}
        </span>
      )}
    </span>
  )
}

interface EditorProps {
  /** The day's current entry, if any. */
  entry?: JournalEntry
  /** YYYY-MM-DD the editor writes into. */
  date: string
  /** Everyone who can be tagged as "who this day was about". */
  people: Person[]
  onSave(e: JournalEntry): void
  /** Clearing every word (and the mood, and the people) removes the entry instead of saving a blank one. */
  onDelete?(id: string): void
  autoFocus?: boolean
  placeholder?: string
  rows?: number
  /** Show a "Delete entry" control (full journal page only). */
  showDelete?: boolean
  /** Start with the whole people list showing (journal page); Today's card keeps it behind "+ Who". */
  peopleOpen?: boolean
}

/**
 * A textarea, five faces and a row of people that autosave into one day's
 * entry. Typing never creates more than one record: the entry made here is
 * remembered until the store echoes it back, and an edit arriving from
 * another device is adopted only while nothing is being typed.
 */
export function JournalEditor({ entry, date, people, onSave, onDelete, autoFocus, placeholder, rows = 3, showDelete, peopleOpen }: EditorProps) {
  const [body, setBody] = useState(entry?.body ?? '')
  const [mood, setMood] = useState<Mood | undefined>(entry?.mood)
  const [peopleIds, setPeopleIds] = useState<string[]>(entry?.peopleIds ?? [])
  const [showPeople, setShowPeople] = useState(!!peopleOpen)
  const latest = useRef<JournalDraft>({ body, mood, peopleIds })
  useLayoutEffect(() => {
    latest.current = { body, mood, peopleIds }
  })
  const created = useRef<JournalEntry | null>(null)
  /** Whether this editor made an entry the store has not echoed back yet: what the Delete button reads. */
  const [createdHere, setCreatedHere] = useState(false)
  /** The entry made here, for the ref and for the render: a commit reads the ref, as two can land before a render. */
  const remember = (made: JournalEntry | null) => {
    created.current = made
    setCreatedHere(made !== null)
  }
  const seen = useRef<JournalDraft>(draftOf(entry))
  const timer = useRef<number | undefined>(undefined)
  const [savedAt, setSavedAt] = useState<string | undefined>(entry?.updatedAt)

  /**
   * The box grows with what is in it. `resize: vertical` is the only other
   * affordance and WKWebView draws no handle for it, so without this the phone
   * writes into a fixed two-line slit that scrolls under its own thumb. The CSS
   * max-height caps the growth and turns the overflow back into a scroller.
   *
   * Two details keep the growth from costing anything elsewhere. The
   * measurement clears the inline height rather than setting `auto`, so the box
   * falls back to the height `rows` asked for and no inline height is written
   * at all while the text still fits — that is what leaves the desktop editor
   * exactly as tall as its `rows`. And a box that HAS grown does collapse for
   * the one layout the measurement forces; WebKit clamps the document scroll
   * while the page is briefly shorter and does not put it back, which would
   * ratchet a long entry upward on every keystroke, so the scroll offset is
   * carried across the measurement (a no-op whenever nothing clamped).
   */
  const box = useRef<HTMLTextAreaElement>(null)
  const fit = useCallback(() => {
    const el = box.current
    if (!el) return
    const top = window.scrollY
    el.style.height = ''
    // scrollHeight covers content + padding but not the border; under
    // box-sizing: border-box the height has to carry the border as well
    if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
    // `behavior: 'instant'` because the document scrolls smoothly by default
    // (html's scroll-behavior, src/styles/) — an animated correction on every keystroke would drift the
    // page out from under the caret
    if (window.scrollY !== top) window.scrollTo({ top, behavior: 'instant' })
  }, [])
  useLayoutEffect(fit, [body, fit])
  /** A pinned height is only right for the width it was measured at: rotating the
   *  phone (and the Capacitor keyboard resize) rewraps the text, so measure again. */
  useEffect(() => {
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  /** The id this editor just removed; a stale commit for it must not remove it twice. */
  const deletedId = useRef<string | null>(null)

  const commit = () => {
    window.clearTimeout(timer.current)
    const { body, mood, peopleIds } = latest.current
    const ids = idSet(peopleIds) // never store an empty array
    const blank = !body.trim() && mood === undefined && !ids
    const cur = entry ?? created.current ?? undefined
    if (cur && cur.id === deletedId.current) return
    if (!cur) {
      if (blank) return
      const next = newEntry(date, body, mood, ids)
      remember(next)
      seen.current = { body, mood, peopleIds }
      setSavedAt(next.updatedAt)
      onSave(next)
      return
    }
    if (cur.body === body && cur.mood === mood && samePeople(cur.peopleIds, ids)) return
    if (blank && onDelete) {
      remember(null)
      deletedId.current = cur.id
      seen.current = { body: '', mood: undefined, peopleIds: [] }
      onDelete(cur.id)
      return
    }
    const next: JournalEntry = { ...cur, body, mood, peopleIds: ids, updatedAt: newerStamp(cur.updatedAt) }
    if (!entry) remember(next)
    seen.current = { body, mood, peopleIds }
    setSavedAt(next.updatedAt)
    onSave(next)
  }
  const commitRef = useRef(commit)
  useLayoutEffect(() => {
    commitRef.current = commit
  })

  useEffect(() => {
    // Typing while a change lands from elsewhere (the other editor on this day,
    // another device, a Shortcut, an agent): mergeDraft keeps what was typed
    // here, takes every field that was not touched here, and carries an
    // appended line along instead of overwriting it.
    const cur = latest.current
    const { draft, carried } = mergeDraft(cur, seen.current, entry)
    // only the fields that moved are written
    if (draft.body !== cur.body) setBody(draft.body)
    if (draft.mood !== cur.mood) setMood(draft.mood)
    if (!samePeople(draft.peopleIds, cur.peopleIds)) setPeopleIds(draft.peopleIds)
    if (carried) {
      // the carried line is only on screen so far: save it with what was typed here
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => commitRef.current(), SAVE_DELAY)
    }
    seen.current = draftOf(entry)
    if (entry) {
      remember(null)
      // any live entry reaching here (a new id, or the deleted one restored) may be edited again
      deletedId.current = null
      setSavedAt(entry.updatedAt)
    }
  }, [entry, date])
  useEffect(() => () => commitRef.current(), [])

  const schedule = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => commitRef.current(), SAVE_DELAY)
  }

  const togglePerson = (id: string) => {
    setPeopleIds(cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]))
    // state updates after this tick; write on the next one (same as the mood chips)
    window.setTimeout(() => commitRef.current(), 0)
  }
  const selected = peopleOf({ peopleIds }, people)
  const peopleShown = showPeople ? people : selected

  return (
    <div className="journal-editor">
      <div className="mood-row" role="radiogroup" aria-label="How was the day">
        {MOODS.map(m => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mood === m}
            className={mood === m ? 'mood-chip on' : 'mood-chip'}
            title={MOOD_META[m].label}
            onClick={() => {
              setMood(cur => (cur === m ? undefined : m))
              void haptic('light')
              // state updates after this tick; write on the next one
              window.setTimeout(() => commitRef.current(), 0)
            }}
          >
            {MOOD_META[m].emoji}
          </button>
        ))}
        {mood && <small className="muted">{MOOD_META[mood].label}</small>}
      </div>
      <textarea
        ref={box}
        rows={rows}
        value={body}
        placeholder={placeholder ?? 'What happened, what you noticed, what you want to remember…'}
        autoFocus={autoFocus}
        onChange={e => {
          setBody(e.target.value)
          schedule()
        }}
        onBlur={() => commitRef.current()}
      />
      {people.length > 0 && (
        <div className="journal-people" aria-label="Who was this day about">
          {showPeople && <small className="muted">Who was this day about?</small>}
          <div className="platform-toggles">
            {peopleShown.map(p => (
              <button
                key={p.id}
                type="button"
                className={peopleIds.includes(p.id) ? 'toggle on' : 'toggle'}
                aria-pressed={peopleIds.includes(p.id)}
                onClick={() => togglePerson(p.id)}
              >
                {p.emoji ? `${p.emoji} ` : ''}
                {p.name}
              </button>
            ))}
            <button type="button" className="btn subtle" onClick={() => setShowPeople(v => !v)} aria-expanded={showPeople}>
              {showPeople ? 'Hide' : '+ Who'}
            </button>
          </div>
        </div>
      )}
      <div className="journal-editor-foot">
        {showDelete && (entry || createdHere) && onDelete && (
          <ConfirmButton
            className="btn subtle danger"
            confirmLabel="Tap again to delete"
            onConfirm={() => {
              window.clearTimeout(timer.current)
              const id = (entry ?? created.current)!.id
              remember(null)
              deletedId.current = id
              seen.current = { body: '', mood: undefined, peopleIds: [] }
              setBody('')
              setMood(undefined)
              setPeopleIds([])
              onDelete(id)
            }}
          >
            Delete entry
          </ConfirmButton>
        )}
        <small className="muted">{savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'Saves as you type'}</small>
      </div>
    </div>
  )
}

/** Today's card: write today, glance at yesterday, see the streak. */
export function JournalCard({
  entries,
  people,
  onSave,
  onDelete,
  onOpenAll,
}: {
  entries: JournalEntry[]
  people: Person[]
  onSave(e: JournalEntry): void
  onDelete?(id: string): void
  onOpenAll(): void
}) {
  // not localDayKey() alone: this card writes the entry, and a card still
  // holding yesterday after midnight writes into yesterday's record
  const today = useDayKey()
  const entry = entryOn(entries, today)
  const yesterday = entryOn(entries, shiftDayKey(today, -1))
  const run = streak(entries, today)
  const sub = entry
    ? run > 1
      ? `${run} days in a row`
      : 'Written today'
    : run > 0
      ? `How did today go? ${run} day${run === 1 ? '' : 's'} in a row so far`
      : 'How did today go? A line is enough.'
  const fold = useFold('journal', 'the journal')
  return (
    <section className={'chart-card journal-card' + fold.className}>
      <header className="chart-head">
        <div>
          <h3>Journal</h3>
          <p className="chart-sub">{sub}</p>
        </div>
        <button className="btn subtle" onClick={onOpenAll}>
          All entries
        </button>
        {fold.control}
      </header>
      <JournalEditor entry={entry} date={today} people={people} onSave={onSave} onDelete={onDelete} rows={2} placeholder="A line about today…" />
      {yesterday && (yesterday.body.trim() || yesterday.mood) && (
        <button type="button" className="journal-yesterday" onClick={onOpenAll} title="Open the journal">
          <span className="muted">Yesterday </span>
          {yesterday.mood ? `${MOOD_META[yesterday.mood].emoji} ` : ''}
          {excerpt(yesterday.body, 140) || MOOD_META[yesterday.mood!].label}
        </button>
      )}
    </section>
  )
}
