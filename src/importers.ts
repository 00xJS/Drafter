import { unzipSync, strFromU8 } from 'fflate'
import { Metrics, Platform, Post } from './types'
import { hashId } from './postops'

// ---------------------------------------------------------------------------
// Generic CSV
// ---------------------------------------------------------------------------

export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(cur)
      cur = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cur)
      cur = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      cur += c
    }
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

const PLATFORM_ALIASES: Record<string, Platform> = {
  x: 'x', twitter: 'x', 'x (twitter)': 'x',
  instagram: 'instagram', ig: 'instagram',
  threads: 'threads',
  linkedin: 'linkedin', li: 'linkedin',
  facebook: 'facebook', fb: 'facebook',
  tiktok: 'tiktok', tt: 'tiktok',
  youtube: 'youtube', yt: 'youtube',
}

/**
 * Turns a generic analytics CSV into posted posts. Recognized headers
 * (case-insensitive): date, platform, title, text/content/body/caption,
 * likes, comments/replies, shares/retweets/reposts, impressions/views.
 * Ids are derived from content so re-importing the same file is idempotent.
 */
export function postsFromCSV(text: string): Post[] {
  const rows = parseCSV(text)
  if (rows.length < 2) return []
  const headers = rows[0].map(h => h.trim().toLowerCase())
  const col = (...names: string[]) => headers.findIndex(h => names.includes(h))

  const iDate = col('date', 'posted_at', 'posted at', 'published', 'publish time', 'time')
  const iPlatform = col('platform', 'network', 'channel')
  const iTitle = col('title', 'name')
  const iText = col('text', 'content', 'body', 'caption', 'post text', 'tweet text', 'description')
  const iLikes = col('likes', 'favorites', 'reactions')
  const iComments = col('comments', 'replies')
  const iShares = col('shares', 'retweets', 'reposts')
  const iImpr = col('impressions', 'views', 'reach')

  const num = (v?: string) => {
    if (!v) return undefined
    const n = Number(v.replace(/[,\s]/g, ''))
    return Number.isFinite(n) ? n : undefined
  }

  const out: Post[] = []
  for (const r of rows.slice(1)) {
    const body = iText >= 0 ? (r[iText] ?? '').trim() : ''
    const title = iTitle >= 0 ? (r[iTitle] ?? '').trim() : ''
    if (!body && !title) continue

    const rawPlatform = iPlatform >= 0 ? (r[iPlatform] ?? '').trim().toLowerCase() : ''
    const platform = PLATFORM_ALIASES[rawPlatform] ?? 'x'

    const rawDate = iDate >= 0 ? (r[iDate] ?? '').trim() : ''
    const when = rawDate ? new Date(rawDate) : new Date()
    const postedAt = isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString()

    const m: Metrics = {
      likes: num(r[iLikes]),
      comments: num(r[iComments]),
      shares: num(r[iShares]),
      impressions: num(r[iImpr]),
    }
    const metrics: Post['metrics'] = {}
    metrics[platform] = m

    out.push({
      id: `csv-${hashId(platform + '|' + postedAt + '|' + title + '|' + body)}`,
      title,
      body,
      platforms: [platform],
      status: 'posted',
      createdAt: postedAt,
      updatedAt: postedAt,
      postedAt,
      tags: ['imported'],
      metrics,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// X (Twitter) account archive — data/tweets.js from the official download
// ---------------------------------------------------------------------------

interface XTweet {
  id_str?: string
  full_text?: string
  created_at?: string
  favorite_count?: string | number
  retweet_count?: string | number
  in_reply_to_status_id_str?: string
}

function unescapeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

export interface XArchiveResult {
  posts: Post[]
  skippedRetweets: number
}

export function postsFromXArchive(text: string): XArchiveResult {
  let json = text.trim()
  if (json.startsWith('window.YTD')) {
    const eq = json.indexOf('=')
    if (eq === -1) throw new Error('unrecognized X archive format')
    json = json.slice(eq + 1)
  }
  const arr: unknown = JSON.parse(json)
  if (!Array.isArray(arr)) throw new Error('unrecognized X archive format')

  const posts: Post[] = []
  let skippedRetweets = 0
  for (const item of arr) {
    const t: XTweet =
      item && typeof item === 'object' && 'tweet' in item ? ((item as { tweet: XTweet }).tweet ?? {}) : ((item as XTweet) ?? {})
    const body = unescapeXml(t.full_text ?? '')
    if (!body) continue
    if (body.startsWith('RT @')) {
      skippedRetweets++
      continue
    }
    const when = t.created_at ? new Date(t.created_at) : null
    const postedAt = when && !isNaN(when.getTime()) ? when.toISOString() : new Date().toISOString()
    const tags = ['x-archive']
    if (t.in_reply_to_status_id_str) tags.push('reply')
    posts.push({
      id: t.id_str ? `x-${t.id_str}` : `x-${hashId(postedAt + body)}`,
      title: '',
      body,
      platforms: ['x'],
      status: 'posted',
      createdAt: postedAt,
      updatedAt: postedAt, // archive dates lose to any local edit in the LWW merge
      postedAt,
      tags,
      link: t.id_str ? `https://x.com/i/web/status/${t.id_str}` : undefined,
      metrics: {
        x: {
          likes: Number(t.favorite_count ?? 0) || 0,
          shares: Number(t.retweet_count ?? 0) || 0,
        },
      },
    })
  }
  return { posts, skippedRetweets }
}

// ---------------------------------------------------------------------------
// Instagram "Download your information" export — content/posts_1.json
// ---------------------------------------------------------------------------

function looksMojibake(s: string): boolean {
  return /[\u00c2-\u00f4][\u0080-\u00bf]/.test(s)
}

/** Instagram exports encode UTF-8 bytes as latin-1 code points; undo that. */
export function fixLatin1Utf8(s: string): string {
  if (!looksMojibake(s)) return s
  try {
    const bytes = Uint8Array.from([...s].map(c => c.charCodeAt(0) & 0xff))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return s
  }
}

interface IgMedia {
  creation_timestamp?: number
  title?: string
}

interface IgPost {
  media?: IgMedia[]
  title?: string
  creation_timestamp?: number
}

export function postsFromInstagramArchive(text: string): Post[] {
  const data: unknown = JSON.parse(text)
  const list: IgPost[] = Array.isArray(data) ? data : []
  const posts: Post[] = []
  list.forEach(item => {
    if (!item || typeof item !== 'object') return
    const media = Array.isArray(item.media) ? item.media : []
    const ts = item.creation_timestamp ?? media[0]?.creation_timestamp
    if (typeof ts !== 'number') return
    const caption = fixLatin1Utf8((item.title ?? media[0]?.title ?? '').trim())
    const postedAt = new Date(ts * 1000).toISOString()
    posts.push({
      // timestamp + caption hash: stable across re-exports, unlike the array index
      id: `ig-${ts}-${hashId(caption)}`,
      title: '',
      body: caption,
      platforms: ['instagram'],
      status: 'posted',
      createdAt: postedAt,
      updatedAt: postedAt,
      postedAt,
      tags: ['ig-archive'],
    })
  })
  return posts
}

// ---------------------------------------------------------------------------
// Entry point: a .zip archive, tweets.js, or posts_*.json
// ---------------------------------------------------------------------------

export interface ArchiveImportResult {
  posts: Post[]
  source: string
  skippedRetweets: number
}

const X_FILE = /(^|\/)tweets?\.js$/
const IG_FILE = /(^|\/)posts_\d+\.json$/

export function importArchiveFile(name: string, buf: ArrayBuffer): ArchiveImportResult {
  if (name.toLowerCase().endsWith('.zip')) {
    const files = unzipSync(new Uint8Array(buf), {
      filter: f => X_FILE.test(f.name) || IG_FILE.test(f.name),
    })
    const posts: Post[] = []
    const sources: string[] = []
    let skippedRetweets = 0
    for (const [path, data] of Object.entries(files)) {
      const text = strFromU8(data)
      if (X_FILE.test(path)) {
        const r = postsFromXArchive(text)
        posts.push(...r.posts)
        skippedRetweets += r.skippedRetweets
        sources.push('X archive')
      } else {
        posts.push(...postsFromInstagramArchive(text))
        sources.push('Instagram archive')
      }
    }
    if (sources.length === 0) {
      throw new Error('no tweets.js or posts_*.json found in the zip — for very large archives, unzip it and pick the file directly')
    }
    return { posts, source: [...new Set(sources)].join(' + '), skippedRetweets }
  }

  const text = new TextDecoder().decode(buf)
  const trimmed = text.trimStart()
  if (trimmed.startsWith('window.YTD')) {
    const r = postsFromXArchive(text)
    return { posts: r.posts, source: 'X archive', skippedRetweets: r.skippedRetweets }
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed) && parsed.some(it => it && typeof it === 'object' && 'tweet' in (it as object))) {
      const r = postsFromXArchive(text)
      return { posts: r.posts, source: 'X archive', skippedRetweets: r.skippedRetweets }
    }
    return { posts: postsFromInstagramArchive(text), source: 'Instagram archive', skippedRetweets: 0 }
  }
  throw new Error('unrecognized file — expected an account archive .zip, tweets.js, or posts_*.json')
}
