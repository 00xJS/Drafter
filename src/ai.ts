import { Platform, PLATFORM_META, Post, engagement, impressions } from './types'
import { apiFetch } from './api'
import { fmtDate } from './utils'

// All AI calls go through the session-gated /api/ai proxy (the Netlify
// function). No API key ever reaches the browser.

class AIError extends Error {}

async function complete(system: string, prompt: string, maxTokens = 2048): Promise<string> {
  let res: Response
  try {
    res = await apiFetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system, prompt, maxTokens }),
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

/** Rewrite one draft as platform-native variants, respecting each platform's limit. */
export async function generateVariants(body: string, platforms: Platform[]): Promise<Partial<Record<Platform, string>>> {
  const specs = platforms
    .map(pl => `- "${pl}" (${PLATFORM_META[pl].label}, hard limit ${PLATFORM_META[pl].charLimit} characters)`)
    .join('\n')
  const text = await complete(
    'You adapt social media drafts into platform-native versions. Keep the author\'s voice and message; adjust length, tone, hashtag and emoji conventions to each platform. Never exceed a platform\'s character limit.',
    `Adapt this draft for each platform below.\n\nDraft:\n"""\n${body}\n"""\n\nPlatforms:\n${specs}\n\nRespond with ONLY a JSON object mapping each platform id to its adapted text, e.g. {"x": "...", "instagram": "..."}.`,
  )
  const raw = extractJSON<Record<string, unknown>>(text)
  const out: Partial<Record<Platform, string>> = {}
  for (const pl of platforms) {
    const v = raw[pl]
    if (typeof v === 'string' && v.trim()) out[pl] = v.trim()
  }
  if (Object.keys(out).length === 0) throw new AIError('The model returned no usable variants.')
  return out
}

/** Suggest a handful of tags for a draft. */
export async function suggestTags(body: string): Promise<string[]> {
  const text = await complete(
    'You suggest short lowercase content tags (topics/themes, not platform names) for organizing social media posts.',
    `Suggest 3–6 tags for this post. Respond with ONLY a JSON array of lowercase strings without "#", e.g. ["launch","tips"].\n\nPost:\n"""\n${body}\n"""`,
    512,
  )
  const raw = extractJSON<unknown[]>(text)
  return raw
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-'))
    .filter(Boolean)
    .slice(0, 6)
}

/** Explain what the account's best posts have in common and what to do next. */
export async function analyzeTopPosts(posts: Post[]): Promise<string> {
  const rows = posts
    .slice(0, 15)
    .map(p => {
      const text = (p.body || p.title).replace(/\s+/g, ' ').slice(0, 160)
      return `- ${fmtDate(p.postedAt)} · ${p.platforms.join('+')} · ${engagement(p)} engagement · ${impressions(p)} impressions · tags: ${p.tags.join(', ') || 'none'}\n  "${text}"`
    })
    .join('\n')
  return complete(
    'You are a sharp, practical social media analyst. Be specific and concrete; no fluff, no generic advice that could apply to any account.',
    `Here are my recent top posts by engagement:\n\n${rows}\n\nIn plain text (short paragraphs and "-" bullets only, no markdown headings): 1) what the strongest posts have in common, 2) any pattern in what underperforms relative to reach, 3) three concrete things to try next, based only on this data.`,
    1500,
  )
}

/** Break a task into concrete checklist steps. */
export async function suggestChecklist(title: string, description: string): Promise<string[]> {
  const text = await complete(
    'You are a pragmatic project planner for personal and household projects. Break work into small, concrete, actionable steps a single person can tick off. No fluff.',
    `Break this task into 3–8 checklist steps. Respond with ONLY a JSON array of short strings (imperative, under 80 characters each).\n\nTask: ${title}\n${description ? `Details:\n"""\n${description}\n"""` : ''}`,
    768,
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
}): Promise<CatchUpIdea[]> {
  const recent = input.recent.length ? input.recent.map(r => `- ${r.when}: ${r.what}`).join('\n') : '- nothing logged yet'
  const text = await complete(
    'You help someone keep up with the people they love. Suggest specific, low-effort, realistic plans — a call, a walk, lunch, an errand done together, a game night — not grand gestures. Vary the ideas. Use what you know about the person; never invent facts about them.',
    `Person: ${input.name} (${input.group})\n${input.daysSince !== undefined ? `Last seen: ${input.daysSince} days ago` : 'Never logged'}\nNotes about them: ${input.notes || '(none)'}\nRecent times together:\n${recent}\n\nSuggest 4 ideas for the next catch-up. Respond with ONLY a JSON array of objects {"title": "short imperative plan, under 60 chars", "why": "one sentence tying it to what you know"}.`,
    768,
  )
  const raw = extractJSON<unknown[]>(text)
  return raw
    .filter((x): x is { title?: unknown; why?: unknown } => !!x && typeof x === 'object')
    .map(x => ({ title: String(x.title ?? '').trim(), why: String(x.why ?? '').trim() }))
    .filter(x => x.title)
    .slice(0, 4)
}
