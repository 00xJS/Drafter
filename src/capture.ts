import type { Task } from './types'
import { localMidnightIso } from '../shared/domain.mts'

// A typed line read as a task, offline: the date and clock time a sentence
// names, and the task those fields make. The palette's Shift+Enter, Siri's
// "Add to Drafter" and the editor all file a capture through these at once, so
// they load with the shell. The model's fuller reading (parseCapture, in ai.ts)
// is merged in afterwards, and ai.ts loads only when it is asked for.
//
// Every day and time here is this device's: the model is told the time on its
// clock and in its zone, and a time it names without an offset is read on the
// same clock (modelDueAt).

// No project in either: there is one ongoing project, and a captured sentence
// never files a task under one — from the palette or the editor.
export interface CaptureCtx {
  now?: Date
  personNames?: string[]
}

export interface CapturedFields {
  title: string
  dueAt?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  peopleNames?: string[]
  tags?: string[]
  recurrence?: 'daily' | 'weekly' | 'biweekly' | 'monthly'
}

/** Title + optional body for parseCapture; a pasted URL is pulled into `url`. */
export function captureSeed(title: string, description = '', link?: string): { text: string; url?: string } {
  const t = title.trim()
  const fromTitle = /^https?:\/\//i.test(t) ? t : undefined
  const fromLink = link && /^https?:\/\//i.test(link.trim()) ? link.trim() : undefined
  const url = fromTitle ?? fromLink
  const text = [fromTitle ? '' : t, description.trim()].filter(Boolean).join('\n').trim() || t
  return { text, url }
}

/** True when the only structured find is a date/time — apply it without a Review tap. */
export function isSimpleDateCapture(parsed: CapturedFields, original: string, now = new Date()): boolean {
  if (!parsed.dueAt) return false
  if (parsed.priority || parsed.peopleNames?.length || parsed.tags?.length || parsed.recurrence) return false
  return !!deterministicCapture(original, now)?.dueAt
}

/**
 * What the editor applies with no Review tap when the only find is a date:
 * the date, and the title as typed less the words that named it — the offline
 * reading's, as the palette files it. Never the model's rewording of the
 * title, which nobody would have seen before it replaced what they typed.
 * Null when there is more to it than a date, and the proposal is shown.
 */
export function simpleDateCapture(parsed: CapturedFields, original: string, now = new Date()): CapturedFields | null {
  if (!isSimpleDateCapture(parsed, original, now)) return null
  const typed = deterministicCapture(original, now)
  return typed ? { title: typed.title, dueAt: parsed.dueAt } : null
}

const DAY_MS = 86_400_000

/**
 * The instant a model's `dueAt` names, read the way the person meant it. With
 * an offset or a Z it is kept as it is. Without one — '2026-09-24T15:00' — it
 * is this device's wall clock; a bare day is that day with no time, local
 * midnight, as the editor and reminders read a day. Date.parse read a bare day
 * as UTC midnight, which in Phoenix is five in the afternoon the day before.
 * Undefined for anything else, for a day the calendar does not have, and for
 * a time more than a day gone: a model that guessed the year wrong would file
 * the task as long overdue.
 */
export function modelDueAt(value: unknown, now = new Date()): string | undefined {
  const s = typeof value === 'string' ? value.trim() : ''
  let ms = NaN
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/i.exec(s)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const at = m[4] === undefined ? new Date(localMidnightIso(`${m[1]}-${m[2]}-${m[3]}`) ?? NaN) : new Date(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
    // new Date rolls 30 February into March; a day that rolled is not the day named
    if (at.getFullYear() === y && at.getMonth() === mo - 1 && at.getDate() === d && Number(m[4] ?? 0) < 24 && Number(m[5] ?? 0) < 60) ms = at.getTime()
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) ms = Date.parse(s)
  if (!Number.isFinite(ms) || ms < now.getTime() - DAY_MS) return undefined
  return new Date(ms).toISOString()
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
}

/**
 * A clock time in a captured sentence — but only when the writer clearly meant
 * one. A bare number must NOT be read as an hour: "Buy 2 tickets" used to parse
 * as "Buy tickets" due at 02:00, deleting the quantity from the title and
 * inventing a due time that was already in the past. So a match needs one of
 * three explicit signals: an "at" in front, a `h:mm`, or an am/pm suffix.
 * Out-of-range values (25, :70) are not times either.
 */
function matchTime(s: string): { text: string; index: number; hour: number; minute: number } | null {
  const shapes: [RegExp, boolean][] = [
    [/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i, false], // at 3 · at 3:30 · at 3pm
    [/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i, false], // 15:30 · 3:30pm
    [/\b(\d{1,2})\s*(am|pm)\b/i, true], // 3pm · 11 am
  ]
  for (const [re, apInSecondGroup] of shapes) {
    const m = s.match(re)
    if (!m || m.index === undefined) continue
    let hour = Number(m[1])
    const minute = apInSecondGroup ? 0 : Number(m[2] ?? 0)
    const ap = (apInSecondGroup ? m[2] : m[3] ?? '').toLowerCase()
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) continue
    if (ap ? hour < 1 || hour > 12 : hour > 23) continue
    if (ap === 'pm' && hour < 12) hour += 12
    if (ap === 'am' && hour === 12) hour = 0
    return { text: m[0], index: m.index, hour, minute }
  }
  return null
}

/** Offline pre-pass: today/tomorrow/weekday + an explicit clock time. Returns null when nothing matches. */
export function deterministicCapture(text: string, now = new Date()): CapturedFields | null {
  const raw = text.trim()
  if (!raw) return null
  let due: Date | null = null
  let rest = raw

  const dayRe = /\b(today|tomorrow|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i

  const dayMatch = rest.match(dayRe)
  if (dayMatch) {
    const token = dayMatch[1].toLowerCase()
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0)
    if (token === 'today') {
      due = base
    } else if (token === 'tomorrow') {
      base.setDate(base.getDate() + 1)
      due = base
    } else {
      const want = WEEKDAYS[token]
      if (want !== undefined) {
        const delta = (want - base.getDay() + 7) % 7 || 7
        base.setDate(base.getDate() + delta)
        due = base
      }
    }
    rest = (rest.slice(0, dayMatch.index) + rest.slice(dayMatch.index! + dayMatch[0].length)).replace(/\s{2,}/g, ' ').trim()
  }

  const timeMatch = matchTime(rest) ?? matchTime(raw)
  if (timeMatch) {
    const { text: hit, index, hour, minute } = timeMatch
    if (!due) due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0)
    due.setHours(hour, minute, 0, 0)
    if (rest.includes(hit)) {
      const at = rest.indexOf(hit) === index ? index : rest.indexOf(hit)
      rest = (rest.slice(0, at) + rest.slice(at + hit.length)).replace(/\s{2,}/g, ' ').trim()
    }
  }

  if (!due) return null
  const title = rest.replace(/^[\s,.\-–—:]+|[\s,.\-–—:]+$/g, '').trim() || raw
  return { title, dueAt: due.toISOString() }
}

/**
 * What parseCapture would return if the model never answered. The palette's
 * Shift+Enter files the line with this at once — a keystroke must not wait on
 * /api/ai (its timeout is 180 s) — and merges the model's answer in afterwards
 * if the task is still there and untouched.
 */
export function quickCaptureFields(line: string, now = new Date()): CapturedFields {
  return deterministicCapture(line, now) ?? { title: line.trim().slice(0, 140) }
}

/** Words that ask for a priority or a repeat, which only the model reads. */
const PRIORITY_CUE = /!|\b(?:urgent|urgently|asap|important|priority|critical)\b/i
const REPEAT_CUE = /\b(?:every|each|daily|weekly|fortnightly|biweekly|monthly|yearly|annually)\b/i

/** Letters and digits only, lower case, no accents: how a name is looked for in a line. */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * Whether the palette's capture still needs the model once the offline read
 * has landed. The offline read finds a day and a time; only the model reads a
 * person, a priority or a repeat, or a day put another way ("next weekend").
 * A line with its date found and none of the others has nothing left for the
 * model but a guess at tags — and the call would still spend one of the
 * account's thirty a ten minutes, and could come back half a minute later to
 * change a task the person has moved on from.
 */
export function captureNeedsModel(line: string, offline: CapturedFields, personNames: readonly string[] = []): boolean {
  if (!offline.dueAt) return true
  if (PRIORITY_CUE.test(line) || REPEAT_CUE.test(line)) return true
  const words = ` ${fold(line)} `
  // any word of a saved name will do: "call Sarah" may mean Sarah Jones
  return personNames.some(name => fold(name).split(' ').some(w => w.length > 1 && words.includes(` ${w} `)))
}

/** The names a capture can resolve against — people, matched by name. */
export interface CaptureLookup {
  people: { id: string; name: string }[]
}

/**
 * Captured fields → a whole task, mapped exactly as the editor's applyCapture
 * would: names become ids by case-insensitive match, unknown names are
 * dropped, and nothing is set that the sentence did not say. It is never filed
 * under a project, so an undated line lands in Today's Inbox.
 */
export function buildCapturedTask(fields: CapturedFields, lookup: CaptureLookup, opts: { id: string; now: Date }): Task {
  const stamp = opts.now.toISOString()
  const title = fields.title.trim().slice(0, 140)
  const peopleIds = [
    ...new Set((fields.peopleNames ?? []).map(n => lookup.people.find(p => p.name.toLowerCase() === n.toLowerCase())?.id).filter((id): id is string => !!id)),
  ]
  const tags = [...new Set((fields.tags ?? []).map(t => t.trim().toLowerCase()).filter(Boolean))]
  return {
    kind: 'task',
    id: opts.id,
    title,
    description: '',
    status: 'todo',
    priority: fields.priority ?? 'normal',
    createdAt: stamp,
    updatedAt: stamp,
    tags,
    ...(fields.dueAt ? { dueAt: fields.dueAt } : {}),
    ...(peopleIds.length ? { peopleIds } : {}),
    ...(fields.recurrence ? { recurrence: { freq: fields.recurrence } } : {}),
  }
}
