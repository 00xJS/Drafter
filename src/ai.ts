import Anthropic from '@anthropic-ai/sdk'
import { Platform, PLATFORM_META, Post, engagement, impressions } from './types'
import { getSupabase } from './supabase'
import { fmtDate } from './utils'

const KEY_STORAGE = 'drafter:ai-key'
const LEGACY_KEY_STORAGE = 'post-pilot:ai-key' // pre-rename builds
const MODEL = 'claude-opus-5'

export function getAIKey(): string {
  try {
    const key = localStorage.getItem(KEY_STORAGE)
    if (key !== null) return key
    const legacy = localStorage.getItem(LEGACY_KEY_STORAGE)
    if (legacy) {
      localStorage.setItem(KEY_STORAGE, legacy)
      localStorage.removeItem(LEGACY_KEY_STORAGE)
      return legacy
    }
    return ''
  } catch {
    return ''
  }
}

export function setAIKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    /* storage unavailable */
  }
}

async function viaProxy(system: string, prompt: string, maxTokens: number): Promise<string | null> {
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // the hosted AI proxy verifies the Supabase session so strangers can't burn credits
    const sb = getSupabase()
    if (sb) {
      const { data } = await sb.auth.getSession()
      if (data.session) headers.authorization = `Bearer ${data.session.access_token}`
    }
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers,
      body: JSON.stringify({ system, prompt, maxTokens }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) return null
    const data: unknown = await res.json()
    const text = data && typeof data === 'object' ? (data as { text?: unknown }).text : null
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

async function complete(system: string, prompt: string, maxTokens = 2048): Promise<string> {
  // Prefer the local server (keeps the API key out of the browser)…
  const proxied = await viaProxy(system, prompt, maxTokens)
  if (proxied !== null) return proxied

  // …fall back to calling the API directly with a key from Settings.
  const apiKey = getAIKey()
  if (!apiKey) {
    throw new Error('No AI access — add an Anthropic API key in Settings, or run `npm run server` with ANTHROPIC_API_KEY set.')
  }
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.')
  let text = ''
  for (const block of response.content) {
    if (block.type === 'text') text += block.text
  }
  if (!text.trim()) throw new Error('Empty response from the model.')
  return text
}

function extractJSON<T>(text: string): T {
  const starts = ['{', '['].map(ch => text.indexOf(ch)).filter(i => i !== -1)
  if (starts.length === 0) throw new Error('The model returned no JSON.')
  const start = Math.min(...starts)
  const close = text[start] === '{' ? '}' : ']'
  const end = text.lastIndexOf(close)
  if (end <= start) throw new Error('The model returned malformed JSON.')
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
  if (Object.keys(out).length === 0) throw new Error('The model returned no usable variants.')
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
