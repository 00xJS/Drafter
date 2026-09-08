import { apiFetch } from './api'

// All AI calls go through the session-gated /api/ai proxy (the Netlify
// function). No API key ever reaches the browser.

class AIError extends Error {}

async function complete(system: string, prompt: string, maxTokens = 2048, json = false): Promise<string> {
  let res: Response
  try {
    res = await apiFetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system, prompt, maxTokens, json }),
      timeoutMs: 180_000,
    })
  } catch (e) {
    throw new AIError((e as Error).message)
  }
  if (res.status === 401) throw new AIError('Session expired — sign in again and retry.')
  if (!res.ok) {
    // 501 = no provider key on the host; the server names the env vars to set.
    const body = await res.json().catch(() => null)
    throw new AIError((body as { error?: string } | null)?.error ?? `AI request failed (HTTP ${res.status}).`)
  }
  const data: unknown = await res.json()
  const text = data && typeof data === 'object' ? (data as { text?: unknown }).text : null
  if (typeof text !== 'string' || !text.trim()) throw new AIError('The model returned an empty response.')
  return text
}

function extractJSON<T>(text: string): T {
  const starts = ['{', '['].map(ch => text.indexOf(ch)).filter(i => i !== -1)
  if (starts.length === 0) throw new AIError('The model returned no JSON.')
  const start = Math.min(...starts)
  const close = text[start] === '{' ? '}' : ']'
  const end = text.lastIndexOf(close)
  if (end <= start) throw new AIError('The model returned malformed JSON.')
  return JSON.parse(text.slice(start, end + 1)) as T
}

/** Suggest a handful of tags for a task. */
export async function suggestTags(body: string): Promise<string[]> {
  const text = await complete(
    'You suggest short lowercase tags (topics/themes) for organizing personal and household tasks.',
    `Suggest 3–6 tags for this task. Respond with ONLY a JSON array of lowercase strings without "#", e.g. ["home","errands"].\n\nTask:\n"""\n${body}\n"""`,
    512,
    true,
  )
  const raw = extractJSON<unknown[]>(text)
  return raw
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-'))
    .filter(Boolean)
    .slice(0, 6)
}

/** Break a task into concrete checklist steps. */
export async function suggestChecklist(title: string, description: string): Promise<string[]> {
  const text = await complete(
    'You are a pragmatic project planner for personal and household projects. Break work into small, concrete, actionable steps a single person can tick off. No fluff.',
    `Break this task into 3–8 checklist steps. Respond with ONLY a JSON array of short strings (imperative, under 80 characters each).\n\nTask: ${title}\n${description ? `Details:\n"""\n${description}\n"""` : ''}`,
    768,
    true,
  )
  const raw = extractJSON<unknown[]>(text)
  return raw
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 8)
}

export type RefineMode = 'clarify' | 'expand' | 'summarize'

export const REFINE_META: Record<RefineMode, { label: string; busy: string; hint: string }> = {
  clarify: { label: '✨ Clarify', busy: 'Clarifying…', hint: 'Rewrite for clarity, same facts' },
  expand: { label: '✨ Add details', busy: 'Expanding…', hint: 'Fill in steps, specifics and open questions' },
  summarize: { label: '✨ Summarize', busy: 'Summarizing…', hint: 'Condense to the essentials' },
}

const REFINE_PROMPTS: Record<RefineMode, string> = {
  clarify:
    'Rewrite the description so it is clear and unambiguous. Keep every fact, number, name and link; fix vague wording; use short sentences and "-" bullets where they help. Do not invent details. Keep roughly the same length.',
  expand:
    'Expand the description into a more complete brief: what "done" looks like, the concrete steps or sub-parts, materials/tools/people involved, and any decisions or open questions to settle. Keep every existing fact; where you add specifics you are unsure of, phrase them as questions or options rather than asserting them. Plain text with "-" bullets.',
  summarize:
    'Condense the description to its essentials: the goal, the key constraints, and the next action. Keep every number, name and link that matters. Aim for a third of the length, plain text, "-" bullets if there are several points.',
}

/** Rewrite a task description in one of three ways; returns the new text only. */
export async function refineDescription(mode: RefineMode, title: string, description: string): Promise<string> {
  const text = await complete(
    'You are a precise editor for personal and household project notes. You only ever return the rewritten description — no preamble, no headings, no markdown emphasis, no quotes around it.',
    `${REFINE_PROMPTS[mode]}\n\nTask title: ${title || '(none)'}\n\nCurrent description:\n"""\n${description}\n"""\n\nReturn ONLY the new description text.`,
    1200,
  )
  return text
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, '')
    .replace(/^["“]|["”]$/g, '')
    .trim()
}

export interface CatchUpIdea {
  title: string
  why: string
}

/** Concrete ideas for the next catch-up with someone, grounded in what you know about them. */
export async function suggestCatchUp(input: {
  name: string
  group: string
  notes?: string
  daysSince?: number
  recent: { what: string; when: string }[]
  /** Places you have been together, most often first. */
  places?: { name: string; category: string; times: number; lastWent: string }[]
  /** Your favourite places they have never been to with you. */
  notYetTogether?: string[]
}): Promise<CatchUpIdea[]> {
  const recent = input.recent.length ? input.recent.map(r => `- ${r.when}: ${r.what}`).join('\n') : '- nothing logged yet'
  const together = input.places?.length ? input.places.map(p => `- ${p.name} (${p.category}) ×${p.times}, last ${p.lastWent}`).join('\n') : '- none logged'
  const untried = input.notYetTogether?.length ? input.notYetTogether.map(n => `- ${n}`).join('\n') : '- none'
  const text = await complete(
    'You help someone keep up with the people they love. Suggest specific, low-effort, realistic plans — a call, a walk, lunch, an errand done together, a game night — not grand gestures. Vary the ideas. Prefer somewhere from their shared history or a favourite they have not tried, and say when you last went. Use what you know about the person; never invent facts about them.',
    `Person: ${input.name} (${input.group})\n${input.daysSince !== undefined ? `Last seen: ${input.daysSince} days ago` : 'Never logged'}\nNotes about them: ${input.notes || '(none)'}\nRecent times together:\n${recent}\nPlaces you have been together:\n${together}\nYour favourites you have not taken them to:\n${untried}\n\nSuggest 4 ideas for the next catch-up. Respond with ONLY a JSON array of objects {"title": "short imperative plan, under 60 chars", "why": "one sentence tying it to what you know"}.`,
    768,
    true,
  )
  const raw = extractJSON<unknown[]>(text)
  return raw
    .filter((x): x is { title?: unknown; why?: unknown } => !!x && typeof x === 'object')
    .map(x => ({ title: String(x.title ?? '').trim(), why: String(x.why ?? '').trim() }))
    .filter(x => x.title)
    .slice(0, 4)
}

export interface OutingIdea {
  title: string
  why: string
  /** Name of one of your places when the idea is about it. */
  placeName?: string
}

/** "Where should we go?" — ideas grounded in your own places: favourites, the ones you drifted from, and what you did lately. */
export async function suggestOuting(input: {
  weekday: string
  favourites: { name: string; category: string; times: number; lastWent: string }[]
  lapsed: { name: string; category: string; times: number; lastWent: string }[]
  recent: { name: string; when: string }[]
  allNames: string[]
}): Promise<OutingIdea[]> {
  const rows = (xs: { name: string; category: string; times: number; lastWent: string }[]) =>
    xs.length ? xs.map(p => `- ${p.name} (${p.category}) ×${p.times}, last ${p.lastWent}`).join('\n') : '- none'
  const text = await complete(
    'You suggest where someone could go next, drawn from places they already know and love. Favour places they used to visit often and have not been back to, then variety of category, then a favourite. Say when they last went. Keep ideas realistic for an ordinary week. Never invent places that are not in the lists; an idea may also be a walk or something free.',
    `It is ${input.weekday}.\nFavourites (most visited this year):\n${rows(input.favourites)}\nDrifted from (used to go, not lately):\n${rows(input.lapsed)}\nRecent outings:\n${input.recent.length ? input.recent.map(r => `- ${r.when}: ${r.name}`).join('\n') : '- none'}\n\nSuggest 4 ideas. Respond with ONLY a JSON array of objects {"title": "short imperative, under 60 chars", "why": "one sentence with the history behind it", "placeName": "exact name from the lists, or omit"}.`,
    768,
    true,
  )
  const raw = extractJSON<unknown[]>(text)
  const known = new Set(input.allNames.map(n => n.toLowerCase()))
  return raw
    .filter((x): x is { title?: unknown; why?: unknown; placeName?: unknown } => !!x && typeof x === 'object')
    .map(x => {
      const placeName = typeof x.placeName === 'string' && known.has(x.placeName.trim().toLowerCase()) ? input.allNames.find(n => n.toLowerCase() === x.placeName!.toString().trim().toLowerCase()) : undefined
      return { title: String(x.title ?? '').trim(), why: String(x.why ?? '').trim(), placeName }
    })
    .filter(x => x.title)
    .slice(0, 4)
}

/** A short, honest write-up of a week or month from its data and the user's reflections. */
export async function summarizeReview(input: {
  period: 'week' | 'month'
  label: string
  done: string[]
  slipped: string[]
  upcoming: string[]
  people: string[]
  /** "Nopi ×2" — where you went this period. */
  places?: string[]
  projects: string[]
  stalled: string[]
  reflections?: string
  /** Prior period's Top 3 commitments. */
  lastTop?: string[]
  /** Which of those Top 3 were kept (done). */
  kept?: boolean[]
  /** Journal lines from the period ("2026-09-08 (mood 4/5): …"), oldest first. */
  journal?: string[]
}): Promise<string> {
  const list = (xs: string[]) => (xs.length ? xs.slice(0, 40).map(x => `- ${x}`).join('\n') : '- none')
  const last =
    input.lastTop && input.lastTop.length
      ? input.lastTop
          .map((t, i) => `- ${t}${input.kept?.[i] ? ' (done)' : ' (not done)'}`)
          .join('\n')
      : '- none recorded'
  return complete(
    'You write a warm, candid personal review — like a good friend who is also organised. Plain text, short paragraphs and "-" bullets only, no headings, no markdown emphasis. Be specific: name the tasks, projects and people. Celebrate real progress, be honest about what slipped, and end with the two or three things that would matter most next. When the journal explains why the period went the way it did, say so in the writer\'s own terms. Never invent anything not in the data.',
    `Period: this ${input.period} (${input.label})\n\nLast ${input.period}'s Top 3:\n${last}\n\nCompleted:\n${list(input.done)}\n\nSlipped (due but not done):\n${list(input.slipped)}\n\nAlready planned for next ${input.period}:\n${list(input.upcoming)}\n\nPeople seen:\n${list(input.people)}\n\nPlaces went:\n${list(input.places ?? [])}\n\nProjects:\n${list(input.projects)}\n\nStalled projects:\n${list(input.stalled)}\n\nMy journal this ${input.period}:\n${list(input.journal ?? [])}\n\nMy own reflections:\n${input.reflections || '(none written)'}\n\nWrite the review in 120–220 words.`,
    900,
  )
}

export interface DraftedPlan {
  durationDays: number
  tasks: { title: string; offsetDays: number; priority?: 'low' | 'normal' | 'high' | 'urgent'; checklist?: string[] }[]
  milestones: { name: string; offsetDays: number }[]
}

/** Turn a goal sentence into a dated plan: tasks with day offsets and a few milestones. */
export async function draftPlan(goal: string, name: string, context?: string): Promise<DraftedPlan> {
  const text = await complete(
    'You are a pragmatic project planner for personal and household projects. Produce realistic, well-ordered plans a single person can follow, with sensible lead times (booking before doing, ordering before assembling). Prefer 8–15 tasks. No fluff.',
    `Project: ${name || '(unnamed)'}\nGoal: ${goal}\n${context ? `Context:\n${context}\n` : ''}\nRespond with ONLY a JSON object: {"durationDays": number, "tasks": [{"title": "imperative, under 70 chars", "offsetDays": days from start (0 = start day), "priority": "low|normal|high|urgent", "checklist": ["optional short steps"]}], "milestones": [{"name": "short", "offsetDays": number}] } with 2–4 milestones.`,
    1800,
    true,
  )
  const raw = extractJSON<{ durationDays?: unknown; tasks?: unknown[]; milestones?: unknown[] }>(text)
  const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d)
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map(t => ({
      title: String(t.title ?? '').trim().slice(0, 120),
      offsetDays: num(t.offsetDays),
      priority: (['low', 'normal', 'high', 'urgent'] as const).find(p => p === t.priority),
      checklist: Array.isArray(t.checklist) ? t.checklist.map(String).filter(Boolean).slice(0, 8) : undefined,
    }))
    .filter(t => t.title)
    .slice(0, 25)
  const milestones = (Array.isArray(raw.milestones) ? raw.milestones : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map(m => ({ name: String(m.name ?? '').trim().slice(0, 60), offsetDays: num(m.offsetDays) }))
    .filter(m => m.name)
    .slice(0, 6)
  if (tasks.length === 0) throw new AIError('The model returned no tasks.')
  return { durationDays: Math.max(1, num(raw.durationDays, Math.max(...tasks.map(t => t.offsetDays), 7))), tasks, milestones }
}

export interface CaptureCtx {
  now?: Date
  timeZone?: string
  projectNames?: string[]
  personNames?: string[]
}

export interface CapturedFields {
  title: string
  dueAt?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  projectName?: string
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
  if (parsed.priority || parsed.projectName || parsed.peopleNames?.length || parsed.tags?.length || parsed.recurrence) return false
  return !!deterministicCapture(original, now)?.dueAt
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

/** Offline pre-pass: today/tomorrow/weekday + h(:mm)(am|pm). Returns null when nothing matches. */
export function deterministicCapture(text: string, now = new Date()): CapturedFields | null {
  const raw = text.trim()
  if (!raw) return null
  let due: Date | null = null
  let rest = raw

  const timeRe = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
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

  const timeMatch = rest.match(timeRe) ?? raw.match(timeRe)
  if (timeMatch) {
    let h = Number(timeMatch[1])
    const m = Number(timeMatch[2] ?? 0)
    const ap = (timeMatch[3] ?? '').toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (!due) due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0)
    due.setHours(h, m, 0, 0)
    if (timeMatch.index !== undefined && rest.includes(timeMatch[0])) {
      rest = (rest.slice(0, timeMatch.index) + rest.slice(timeMatch.index + timeMatch[0].length)).replace(/\s{2,}/g, ' ').trim()
    }
  }

  if (!due) return null
  const title = rest.replace(/^[\s,.\-–—:]+|[\s,.\-–—:]+$/g, '').trim() || raw
  return { title, dueAt: due.toISOString() }
}

/**
 * Turn a typed sentence into structured task fields. Runs a deterministic
 * date/time pre-pass first; on network failure that alone is enough.
 */
export async function parseCapture(text: string, ctx: CaptureCtx = {}): Promise<CapturedFields> {
  const now = ctx.now ?? new Date()
  const local = deterministicCapture(text, now)
  const tz = ctx.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const projects = (ctx.projectNames ?? []).slice(0, 40)
  const people = (ctx.personNames ?? []).slice(0, 40)
  try {
    const modelText = await complete(
      'You parse a single personal-task capture sentence into structured fields. Never invent project or person names that are not in the lists. Prefer imperative short titles. Respond with ONLY JSON.',
      `Now: ${now.toISOString()} (${tz})\nActive projects: ${JSON.stringify(projects)}\nPeople: ${JSON.stringify(people)}\n\nSentence:\n"""\n${text.trim()}\n"""\n\nRespond with ONLY JSON: {"title":"…","dueAt":"ISO optional","priority":"low|normal|high|urgent optional","projectName":"exact name or omit","peopleNames":["exact names"],"tags":["…"],"recurrence":"daily|weekly|biweekly|monthly optional"}`,
      300,
      true,
    )
    const raw = extractJSON<Record<string, unknown>>(modelText)
    const title = String(raw.title ?? '').trim().slice(0, 140) || local?.title || text.trim()
    const dueRaw = typeof raw.dueAt === 'string' ? Date.parse(raw.dueAt) : NaN
    const dueAt = Number.isFinite(dueRaw) ? new Date(dueRaw).toISOString() : local?.dueAt
    const priority = (['low', 'normal', 'high', 'urgent'] as const).find(p => p === raw.priority)
    const projectRaw = typeof raw.projectName === 'string' ? raw.projectName.trim() : ''
    const projectName = projectRaw
      ? projects.find(n => n.toLowerCase() === projectRaw.toLowerCase())
      : undefined
    const peopleNames = Array.isArray(raw.peopleNames)
      ? raw.peopleNames
          .map(String)
          .map(n => people.find(p => p.toLowerCase() === n.toLowerCase()))
          .filter((n): n is string => !!n)
          .slice(0, 8)
      : undefined
    const tags = Array.isArray(raw.tags) ? raw.tags.map(String).map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 8) : undefined
    const recurrence = (['daily', 'weekly', 'biweekly', 'monthly'] as const).find(f => f === raw.recurrence)
    return { title, dueAt, priority, projectName, peopleNames, tags, recurrence }
  } catch {
    if (local) return local
    return { title: text.trim().slice(0, 140) }
  }
}

