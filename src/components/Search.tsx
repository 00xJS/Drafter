import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { GARMENT_TYPE_META, Garment, JournalEntry, MOOD_META, Note, Outfit, PLACE_CATEGORY_META, Person, Place, Project, STATUS_META, Task } from '../types'
import { htmlToText } from '../richtext'
import { relativeDayLabel } from '../journal'
import { looksLikeQuestion } from '../questions'
import { dueLabel } from '../taskutils'
import { excerpt } from '../utils'
import { liveById, orderPieces, outfitLabel, pieceTags } from '../wardrobe'
import { type Listening, listen, speechAvailable } from '../speech'
import { Icon, type IconName } from './Icon'
import { Modal } from './Modal'
import { Collage, GarmentPhoto } from './wardrobe/GarmentPhoto'

/** A palette command: jump somewhere, or do something. `run` closes the palette
 *  itself (the caller wires the navigation/action). */
export interface Command {
  id: string
  label: string
  hint?: string
  icon?: IconName
  /** whether it shows before you type — the quick actions on an empty palette */
  quick?: boolean
  /** extra words to match on (e.g. "review" for the Week command) */
  keywords?: string
  run(): void
}

interface Props {
  tasks: Task[]
  projects: Project[]
  people: Person[]
  places?: Place[]
  journal?: JournalEntry[]
  notes?: Note[]
  /** Your clothes and saved outfits (personal): a piece is found by its name or a tag, an outfit by its name. */
  garments?: Garment[]
  outfits?: Outfit[]
  commands?: Command[]
  onOpenTask(t: Task): void
  onOpenProject(p: Project): void
  onOpenPerson(p: Person): void
  onOpenPlace?(p: Place): void
  onOpenJournal?(e: JournalEntry): void
  /** Open a note in Tasks → Notes. Without it notes are not searched. */
  onOpenNote?(n: Note): void
  /** Open a piece's sheet in Home → Wardrobe. Without it no piece is searched. */
  onOpenGarment?(g: Garment): void
  /** Put a saved outfit in Home → Wardrobe's rows. Without it no outfit is searched. */
  onOpenOutfit?(o: Outfit): void
  onSaw?(p: Person): void
  /** openEditor=false files the line straight to the Inbox with no editor. */
  onCreateTask(title: string, openEditor?: boolean): void
  /** Open Ask Drafter on this question. Without it there is no "Ask Drafter" row. */
  onAsk?(question: string): void
  onClose(): void
}

type WardrobeHit = { kind: 'garment'; score: number; garment: Garment; where: string } | { kind: 'outfit'; score: number; outfit: Outfit; label: string }

type Hit =
  | { kind: 'task'; score: number; task: Task; where: string }
  | { kind: 'project'; score: number; project: Project; where: string }
  | { kind: 'person'; score: number; person: Person; where: string }
  | { kind: 'place'; score: number; place: Place; where: string }
  | { kind: 'journal'; score: number; entry: JournalEntry; where: string }
  | { kind: 'note'; score: number; note: Note; where: string }
  | WardrobeHit
  | { kind: 'create'; score: number; title: string }
  | { kind: 'recent'; score: number; task: Task }
  | { kind: 'command'; score: number; command: Command }
  | { kind: 'ask'; score: number; question: string }

// the lists left out, as the same empty list every time, so the index is not rebuilt for them
const NO_PLACES: Place[] = []
const NO_JOURNAL: JournalEntry[] = []
const NO_NOTES: Note[] = []
const NO_GARMENTS: Garment[] = []
const NO_OUTFITS: Outfit[] = []
const NO_COMMANDS: Command[] = []

/**
 * Where the "Ask Drafter" row goes: first when the query reads as a question
 * ("when did I last…", "…?"), otherwise straight after "Create task".
 */
export function withAskRow<H extends { kind: string }>(hits: H[], ask: H, query: string): H[] {
  const out = [...hits]
  if (looksLikeQuestion(query)) out.unshift(ask)
  else {
    const create = out.findIndex(h => h.kind === 'create')
    out.splice(create === -1 ? out.length : create + 1, 0, ask)
  }
  return out
}

/*
 * The palette searches as you type, so a keystroke must not redo what only
 * changes with the lists: every note's and project pad's HTML read as text
 * (a DOMParser each), and every title, description, tag, comment and step
 * lowercased. That is the index below, built when the lists change; a
 * keystroke only looks the needle up in it.
 */

/** A haystack as shown, and lowercased as searched. */
interface Hay {
  raw: string
  low: string
}
const hay = (raw: string): Hay => ({ raw, low: raw.toLowerCase() })

/** How well `needle` (lowercased) matches a lowercased haystack: earlier and whole-word matches rank higher. */
function scoreIn(low: string, needle: string, weight: number): number {
  if (!low) return 0
  const i = low.indexOf(needle)
  if (i === -1) return 0
  const wordStart = i === 0 || /\s/.test(low[i - 1])
  return weight * (wordStart ? 2 : 1) + (i === 0 ? weight : 0)
}

/** The same, for a haystack not in the index (the commands, a handful). */
const score = (haystack: string, needle: string, weight: number): number => scoreIn(haystack.toLowerCase(), needle, weight)

const OPEN = new Set(['wishlist', 'todo', 'doing', 'blocked'])

interface NoteHay {
  note: Note
  title: Hay
  text: Hay
}

const indexNotes = (notes: readonly Note[]): NoteHay[] =>
  notes.filter(n => !n.deletedAt).map(n => ({ note: n, title: hay(n.title || 'Untitled note'), text: hay(htmlToText(n.body).replace(/\s+/g, ' ').trim()) }))

function noteHitsIn(index: readonly NoteHay[], needle: string): { score: number; note: Note; where: string }[] {
  const out: { score: number; note: Note; where: string }[] = []
  for (const { note, title, text } of index) {
    const s = scoreIn(title.low, needle, 11) + scoreIn(text.low, needle, 3)
    if (s <= 0) continue
    const i = text.low.indexOf(needle)
    out.push({ score: s, note, where: scoreIn(title.low, needle, 1) ? '' : excerpt(text.raw.slice(Math.max(0, i - 30)), 90) })
  }
  return out
}

/**
 * The notes matching `needle` (lowercased): a title match ranks like a place's
 * name, a match in the text like one in a project's notes, and a text match
 * says where it was.
 */
export const noteHits = (notes: Note[], needle: string) => noteHitsIn(indexNotes(notes), needle)

interface PlaceHay {
  place: Place
  name: string
  aliases: Hay[]
  address: Hay
  notes: string
}

const indexPlaces = (places: readonly Place[]): PlaceHay[] =>
  places.filter(p => !p.deletedAt).map(p => ({ place: p, name: p.name.toLowerCase(), aliases: (p.aliases ?? []).map(hay), address: hay(p.address ?? ''), notes: (p.notes ?? '').toLowerCase() }))

function placeHitsIn(index: readonly PlaceHay[], needle: string): { score: number; place: Place; where: string }[] {
  const out: { score: number; place: Place; where: string }[] = []
  for (const { place, name, aliases, address, notes } of index) {
    const alias = aliases.find(a => a.low.includes(needle))
    const s = scoreIn(name, needle, 12) + (alias ? scoreIn(alias.low, needle, 10) : 0) + scoreIn(address.low, needle, 5) + scoreIn(notes, needle, 3)
    if (s <= 0) continue
    const where = scoreIn(name, needle, 1) ? '' : alias ? `also ${alias.raw}` : scoreIn(address.low, needle, 1) ? excerpt(address.raw, 70) : 'in notes'
    out.push({ score: s, place, where })
  }
  return out
}

/**
 * The places matching `needle` (lowercased): by name first, then by another
 * name it goes by, its address or its notes, a hit that was not the name
 * saying which it was.
 */
export const placeHits = (places: Place[], needle: string) => placeHitsIn(indexPlaces(places), needle)

interface WardrobeHay {
  garments: { garment: Garment; name: string; tags: string[]; tagLows: string[]; tagsLow: string }[]
  outfits: { outfit: Outfit; name: string; label: string; labelLow: string; hasPieces: boolean }[]
}

function indexWardrobe(garments: readonly Garment[], outfits: readonly Outfit[]): WardrobeHay {
  const byId = liveById(garments as Garment[])
  return {
    garments: garments
      .filter(g => !g.deletedAt)
      .map(g => {
        const tags = pieceTags(g)
        return { garment: g, name: g.name.toLowerCase(), tags, tagLows: tags.map(t => t.toLowerCase()), tagsLow: tags.join(' ').toLowerCase() }
      }),
    outfits: outfits
      .filter(o => !o.deletedAt)
      .map(o => {
        const label = o.name || outfitLabel(o.garmentIds, byId)
        return { outfit: o, name: (o.name ?? '').toLowerCase(), label, labelLow: label.toLowerCase(), hasPieces: orderPieces(o.garmentIds, byId).length > 0 }
      }),
  }
}

function wardrobeHitsIn(index: WardrobeHay, needle: string, { pieces = true }: { pieces?: boolean } = {}): WardrobeHit[] {
  const out: WardrobeHit[] = []
  for (const g of pieces ? index.garments : []) {
    const s = scoreIn(g.name, needle, 12) + scoreIn(g.tagsLow, needle, 6)
    if (s <= 0) continue
    const tag = scoreIn(g.name, needle, 1) ? undefined : g.tags.find((_, i) => g.tagLows[i].includes(needle))
    out.push({ kind: 'garment', score: s - (g.garment.archivedAt ? 3 : 0), garment: g.garment, where: tag ? `tagged ${tag}` : '' })
  }
  for (const o of index.outfits) {
    // "Pieces since deleted" says what is left; it is not a name to find it by
    const s = o.outfit.name ? scoreIn(o.name, needle, 11) : o.hasPieces ? scoreIn(o.labelLow, needle, 5) : 0
    if (s > 0) out.push({ kind: 'outfit', score: s, outfit: o.outfit, label: o.label })
  }
  return out
}

/**
 * Your clothes and saved outfits matching `needle` (lowercased). A piece ranks
 * by its name as a place does and by a tag as a task does, saying which tag
 * matched; a retired one still shows, below one in use. A saved outfit ranks
 * by its name or, left unnamed, by the pieces it is named by — a little
 * lower, so the piece itself comes first; one whose pieces are all gone has
 * no name to be found by. Nothing in Trash shows. With `pieces` off a piece
 * is no hit of its own, but it still names the outfits it is in.
 */
export const wardrobeHits = (garments: Garment[], outfits: Outfit[], needle: string, opts: { pieces?: boolean } = {}): WardrobeHit[] =>
  wardrobeHitsIn(indexWardrobe(garments, outfits), needle, opts)

interface TaskHay {
  task: Task
  title: string
  description: Hay
  tags: string
  comments: string
  checklist: string
}

const lower = (texts: readonly string[]) => texts.join(' ').toLowerCase()

const indexTasks = (tasks: readonly Task[]): { entries: TaskHay[]; titles: Set<string> } => ({
  entries: tasks.map(t => ({
    task: t,
    title: t.title.toLowerCase(),
    description: hay(t.description),
    tags: lower(t.tags),
    comments: lower((t.comments ?? []).map(c => c.body)),
    checklist: lower((t.checklist ?? []).map(c => c.text)),
  })),
  // every title as a query would equal it: an exact one puts "Create task" below the hits
  titles: new Set(tasks.map(t => t.title.trim().toLowerCase())),
})

const indexProjects = (projects: readonly Project[]) =>
  projects.map(p => ({ project: p, name: p.name.toLowerCase(), description: hay(p.description ?? ''), notes: (p.notesHtml ? htmlToText(p.notesHtml) : (p.notes ?? '')).toLowerCase() }))

const indexPeople = (people: readonly Person[]) => people.map(p => ({ person: p, name: p.name.toLowerCase(), notes: (p.notes ?? '').toLowerCase() }))

const indexJournal = (journal: readonly JournalEntry[]) => journal.map(e => ({ entry: e, body: hay(e.body) }))

/** Everything the palette finds things in, lowercased once: each list's part rebuilt when that list changes, and read by every keystroke. */
export interface SearchIndex {
  tasks: ReturnType<typeof indexTasks>
  projects: ReturnType<typeof indexProjects>
  people: ReturnType<typeof indexPeople>
  places: PlaceHay[]
  journal: ReturnType<typeof indexJournal>
  notes: NoteHay[]
  wardrobe: WardrobeHay
}

export const searchIndex = (lists: {
  tasks: readonly Task[]
  projects: readonly Project[]
  people: readonly Person[]
  places: readonly Place[]
  journal: readonly JournalEntry[]
  notes: readonly Note[]
  garments: readonly Garment[]
  outfits: readonly Outfit[]
}): SearchIndex => ({
  tasks: indexTasks(lists.tasks),
  projects: indexProjects(lists.projects),
  people: indexPeople(lists.people),
  places: indexPlaces(lists.places),
  journal: indexJournal(lists.journal),
  notes: indexNotes(lists.notes),
  wardrobe: indexWardrobe(lists.garments, lists.outfits),
})

/** The hits for `needle` (lowercased, not empty), best first as the caller sorts them. */
function searchHits(index: SearchIndex, needle: string, { notes, pieces, outfits }: { notes: boolean; pieces: boolean; outfits: boolean }): Hit[] {
  const out: Hit[] = []
  for (const t of index.tasks.entries) {
    const s = scoreIn(t.title, needle, 10) + scoreIn(t.description.low, needle, 4) + scoreIn(t.tags, needle, 6) + scoreIn(t.comments, needle, 3) + scoreIn(t.checklist, needle, 3)
    if (s > 0) {
      const where = scoreIn(t.title, needle, 1) ? '' : scoreIn(t.description.low, needle, 1) ? excerpt(t.description.raw, 70) : scoreIn(t.comments, needle, 1) ? 'in comments' : scoreIn(t.checklist, needle, 1) ? 'in checklist' : ''
      out.push({ kind: 'task', score: s + (t.task.status === 'done' || t.task.status === 'canceled' ? -3 : 0), task: t.task, where })
    }
  }
  for (const p of index.projects) {
    const s = scoreIn(p.name, needle, 12) + scoreIn(p.description.low, needle, 4) + scoreIn(p.notes, needle, 3)
    if (s > 0) out.push({ kind: 'project', score: s, project: p.project, where: scoreIn(p.name, needle, 1) ? '' : scoreIn(p.notes, needle, 1) ? 'in notes' : excerpt(p.description.raw, 70) })
  }
  for (const p of index.people) {
    const s = scoreIn(p.name, needle, 12) + scoreIn(p.notes, needle, 3)
    if (s > 0) out.push({ kind: 'person', score: s, person: p.person, where: scoreIn(p.name, needle, 1) ? '' : 'in notes' })
  }
  for (const h of placeHitsIn(index.places, needle)) out.push({ kind: 'place', ...h })
  for (const { entry, body } of index.journal) {
    const s = scoreIn(body.low, needle, 5)
    if (s > 0) {
      const i = body.low.indexOf(needle)
      out.push({ kind: 'journal', score: s, entry, where: excerpt(body.raw.slice(Math.max(0, i - 30)), 90) })
    }
  }
  if (notes) for (const h of noteHitsIn(index.notes, needle)) out.push({ kind: 'note', ...h })
  // the pieces always name an unnamed outfit; they are hits themselves only where they can open
  if (pieces || outfits) out.push(...wardrobeHitsIn(index.wardrobe, needle, { pieces }))
  return out
}

/** Cmd/Ctrl+K palette: jump anywhere, run a command, find anything, or create a
 *  task from what you typed. */
export function Search({
  tasks,
  projects,
  people,
  places = NO_PLACES,
  journal = NO_JOURNAL,
  notes = NO_NOTES,
  garments = NO_GARMENTS,
  outfits = NO_OUTFITS,
  commands = NO_COMMANDS,
  onOpenTask,
  onOpenProject,
  onOpenPerson,
  onOpenPlace,
  onOpenJournal,
  onOpenNote,
  onOpenGarment,
  onOpenOutfit,
  onSaw,
  onCreateTask,
  onAsk,
  onClose,
}: Props) {
  const [q, setQuery] = useState('')
  const [heard, setHeard] = useState<Listening | null>(null)
  const [micNote, setMicNote] = useState('')
  const canAsk = !!onAsk
  const canOpenNote = !!onOpenNote
  const canOpenGarment = !!onOpenGarment
  const canOpenOutfit = !!onOpenOutfit
  // a saved outfit is drawn from its pieces, as it is everywhere in the wardrobe
  const byId = useMemo(() => liveById(garments), [garments])
  const [cursor, setCursor] = useState(0)
  /** A new query puts the highlight back on the first row. */
  const setQ = (next: string) => {
    setQuery(next)
    setCursor(0)
  }
  const input = useRef<HTMLInputElement>(null)
  // the results are a listbox the field drives: focus stays in the field, and
  // aria-activedescendant names the row that Enter would open
  const listId = useId()
  const optionId = (i: number) => `${listId}-${i}`

  useEffect(() => {
    input.current?.focus()
  }, [])

  /* Dictation. The words land in the field and go no further: Enter still
     opens the editor, where parseCapture proposes the date, the people and
     the tags, and you confirm — speaking a task never files one behind your
     back. Only offered where the browser has a recogniser; on the iPhone the
     keyboard's own 🎤 key dictates into this field instead. */
  const [canDictate] = useState(speechAvailable)
  // a palette closed mid-sentence must not leave the microphone open
  useEffect(() => () => heard?.cancel(), [heard])

  function dictate() {
    if (heard) {
      heard.stop()
      return
    }
    setMicNote('')
    const session = listen({
      onText: text => setQ(text),
      onEnd: () => {
        setHeard(null)
        input.current?.focus()
      },
      onError: setMicNote,
    })
    if (session) setHeard(session)
    else setMicNote('Dictation is not available here.')
  }

  // what each list is searched by, each part built when its list changes and
  // never on a keystroke; notes only where one can be opened, and outfits likewise
  const noteList = canOpenNote ? notes : NO_NOTES
  const outfitList = canOpenOutfit ? outfits : NO_OUTFITS
  const taskHay = useMemo(() => indexTasks(tasks), [tasks])
  const projectHay = useMemo(() => indexProjects(projects), [projects])
  const peopleHay = useMemo(() => indexPeople(people), [people])
  const placeHay = useMemo(() => indexPlaces(places), [places])
  const journalHay = useMemo(() => indexJournal(journal), [journal])
  const noteHay = useMemo(() => indexNotes(noteList), [noteList])
  const wardrobeHay = useMemo(() => indexWardrobe(garments, outfitList), [garments, outfitList])

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) {
      // empty palette: the quick-action commands, then the 6 most recent open tasks
      const quick: Hit[] = commands.filter(c => c.quick).map(command => ({ kind: 'command' as const, score: 0, command }))
      const recent: Hit[] = [...tasks]
        .filter(t => OPEN.has(t.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 6)
        .map(task => ({ kind: 'recent' as const, score: 0, task }))
      return [...quick, ...recent]
    }
    const out: Hit[] = []
    for (const c of commands) {
      const s = score(c.label, needle, 9) + score(c.keywords ?? '', needle, 6)
      if (s > 0) out.push({ kind: 'command', score: s, command: c })
    }
    const index: SearchIndex = { tasks: taskHay, projects: projectHay, people: peopleHay, places: placeHay, journal: journalHay, notes: noteHay, wardrobe: wardrobeHay }
    out.push(...searchHits(index, needle, { notes: canOpenNote, pieces: canOpenGarment, outfits: canOpenOutfit }))
    out.sort((a, b) => b.score - a.score)
    const top = out.slice(0, 12)
    const createHit: Hit = { kind: 'create', score: -1, title: q.trim() }
    if (taskHay.titles.has(needle)) top.push(createHit)
    else top.unshift(createHit)
    return canAsk ? withAskRow<Hit>(top, { kind: 'ask', score: 0, question: q.trim() }, q) : top
  }, [q, taskHay, projectHay, peopleHay, placeHay, journalHay, noteHay, wardrobeHay, tasks, commands, canAsk, canOpenNote, canOpenGarment, canOpenOutfit])

  // a click on the create row opens the editor; only Shift+Enter passes false
  const pick = (h: Hit, openEditor = true) => {
    onClose()
    if (h.kind === 'task' || h.kind === 'recent') onOpenTask(h.task)
    else if (h.kind === 'project') onOpenProject(h.project)
    else if (h.kind === 'person') onOpenPerson(h.person)
    else if (h.kind === 'place') onOpenPlace?.(h.place)
    else if (h.kind === 'journal') onOpenJournal?.(h.entry)
    else if (h.kind === 'note') onOpenNote?.(h.note)
    else if (h.kind === 'garment') onOpenGarment?.(h.garment)
    else if (h.kind === 'outfit') onOpenOutfit?.(h.outfit)
    else if (h.kind === 'command') h.command.run()
    else if (h.kind === 'create' && h.title) onCreateTask(h.title, openEditor)
    else if (h.kind === 'ask') onAsk?.(h.question)
  }

  return (
    <Modal onClose={onClose} className="search-palette" backdropClassName="modal-backdrop search-backdrop" label="Search">
      <div className="search-field">
      <input
        ref={input}
        className="search-input"
        role="combobox"
        aria-label="Search"
        aria-autocomplete="list"
        aria-expanded={hits.length > 0}
        aria-controls={hits.length > 0 ? listId : undefined}
        aria-activedescendant={hits[cursor] ? optionId(cursor) : undefined}
        value={q}
        /* short enough to fit a phone: at 402pt the long form was cut
           mid-word ("…a view, a perso"), and the list below it already shows
           what this does — New task, Plan my day, a view, a person */
        placeholder="Search or jump to anything…"
        onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setCursor(c => Math.min(c + 1, Math.max(hits.length - 1, 0)))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setCursor(c => Math.max(c - 1, 0))
          } else if (e.key === 'Enter' && hits[cursor]) {
            const h = hits[cursor]
            // Enter edits, Shift+Enter captures without stopping at the editor
            if (h.kind === 'create' && h.title) pick(h, !e.shiftKey)
            else pick(h)
          }
        }}
      />
      {canDictate && (
        <button
          type="button"
          className={heard ? 'icon-btn search-mic listening' : 'icon-btn search-mic'}
          aria-label={heard ? 'Stop dictating' : 'Dictate'}
          aria-pressed={!!heard}
          onClick={dictate}
        >
          <Icon name="mic" size={18} />
        </button>
      )}
      </div>
      {micNote && <p className="empty search-empty">{micNote}</p>}
      {hits.length === 0 && q.trim() && <p className="empty search-empty">No matches. Keep typing to create “{q.trim()}”.</p>}
      {hits.length === 0 && !q.trim() && (
        <p className="empty search-empty">
          No open tasks yet.{' '}
          <button type="button" className="btn subtle" onClick={() => { onClose(); onCreateTask('', true) }}>
            + New task
          </button>
        </p>
      )}
      {hits.length > 0 && (
        <ul className="search-results" id={listId} role="listbox" aria-label="Results">
          {hits.map((h, i) => {
            const active = i === cursor
            if (h.kind === 'command')
              return (
                <li key={h.command.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active command' : 'search-hit command'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">{h.command.icon ? <Icon name={h.command.icon} size={17} /> : '⌘'}</span>
                  <span className="search-main">
                    {h.command.label}
                    {h.command.hint && <small>{h.command.hint}</small>}
                  </span>
                </li>
              )
            if (h.kind === 'create')
              return (
                <li key="create" id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active create' : 'search-hit create'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">＋</span>
                  <span className="search-main">
                    Create task “{h.title}”<small>Enter to edit · Shift+Enter to capture</small>
                  </span>
                  {/* the touch route to capture: a phone has no Shift key, and a tap
                      on the row itself opens the editor */}
                  <button
                    type="button"
                    className="btn subtle"
                    onClick={e => {
                      e.stopPropagation()
                      pick(h, false)
                    }}
                  >
                    Capture
                  </button>
                </li>
              )
            if (h.kind === 'ask')
              return (
                <li key="ask" id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active ask' : 'search-hit ask'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind" aria-hidden>
                    ✨
                  </span>
                  <span className="search-main">
                    Ask Drafter: “{h.question}”<small>Answers from your own planner</small>
                  </span>
                </li>
              )
            if (h.kind === 'task' || h.kind === 'recent') {
              // what tells two tasks apart: when each is due, and where the words
              // matched — never the project, as there is one ongoing project
              const sub = [dueLabel(h.task), h.kind === 'task' ? h.where : ''].filter(Boolean).join(' · ')
              return (
                <li key={h.task.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">
                    <Icon name="checkbox" size={17} />
                  </span>
                  <span className="search-main">
                    {h.task.title || 'Untitled'}
                    {sub && <small>{sub}</small>}
                  </span>
                  <span className="badge" style={{ background: STATUS_META[h.task.status].bg, color: STATUS_META[h.task.status].color }}>
                    {STATUS_META[h.task.status].label}
                  </span>
                </li>
              )
            }
            if (h.kind === 'project')
              return (
                <li key={h.project.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">
                    <span className="pdot" style={{ background: h.project.color }} />
                  </span>
                  <span className="search-main">
                    {h.project.emoji ? `${h.project.emoji} ` : ''}
                    {h.project.name}
                    <small>Project{h.where ? ` · ${h.where}` : ''}</small>
                  </span>
                </li>
              )
            if (h.kind === 'place')
              return (
                <li key={h.place.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">
                    <span className="person-avatar small" style={{ background: h.place.color }}>
                      {h.place.emoji ?? PLACE_CATEGORY_META[h.place.category].emoji}
                    </span>
                  </span>
                  <span className="search-main">
                    {h.place.name}
                    <small>
                      {PLACE_CATEGORY_META[h.place.category].label}
                      {h.where ? ` · ${h.where}` : ''}
                    </small>
                  </span>
                </li>
              )
            if (h.kind === 'note') {
              // a note names no project here either: there is one ongoing project
              return (
                <li key={h.note.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind" aria-hidden>
                    📝
                  </span>
                  <span className="search-main">
                    {h.note.title || 'Untitled note'}
                    <small>
                      Note{h.where ? ` · ${h.where}` : ''}
                    </small>
                  </span>
                </li>
              )
            }
            // a piece wears its own thumbnail, a saved outfit the collage its tile has
            if (h.kind === 'garment')
              return (
                <li key={h.garment.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">
                    <GarmentPhoto garment={h.garment} className="thumb-28" />
                  </span>
                  <span className="search-main">
                    {h.garment.name}
                    <small>
                      {GARMENT_TYPE_META[h.garment.type].label}
                      {h.garment.archivedAt ? ' · Retired' : ''}
                      {h.where ? ` · ${h.where}` : ''}
                    </small>
                  </span>
                </li>
              )
            if (h.kind === 'outfit')
              return (
                <li key={h.outfit.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">
                    <Collage ids={h.outfit.garmentIds} byId={byId} className="search-collage" />
                  </span>
                  <span className="search-main">
                    {h.label}
                    <small>Saved outfit</small>
                  </span>
                </li>
              )
            if (h.kind === 'journal')
              return (
                <li key={h.entry.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                  <span className="search-kind">{h.entry.mood ? MOOD_META[h.entry.mood].emoji : '📓'}</span>
                  <span className="search-main">
                    {relativeDayLabel(h.entry.date)}
                    <small>Journal · {h.where}</small>
                  </span>
                </li>
              )
            return (
              <li key={h.person.id} id={optionId(i)} role="option" aria-selected={active} className={active ? 'search-hit active' : 'search-hit'} onMouseEnter={() => setCursor(i)} onClick={() => pick(h)}>
                <span className="search-kind">
                  <span className="person-avatar small" style={{ background: h.person.color }}>
                    {h.person.emoji ?? h.person.name.slice(0, 1)}
                  </span>
                </span>
                <span className="search-main">
                  {h.person.name}
                  <small>Person{h.where ? ` · ${h.where}` : ''}</small>
                </span>
                {onSaw && (
                  <button
                    type="button"
                    className="btn subtle"
                    onClick={e => {
                      e.stopPropagation()
                      onClose()
                      onSaw(h.person)
                    }}
                  >
                    Saw {h.person.name.split(' ')[0]} today
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
