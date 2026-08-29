import { describe, expect, it } from 'vitest'
import { fixLatin1Utf8, postsFromCSV, postsFromInstagramArchive, postsFromXArchive } from '../importers'

describe('postsFromCSV', () => {
  const csv =
    'date,platform,text,likes,comments,retweets,impressions\n' +
    '2026-07-01,Twitter,"Hello, world",120,10,5,"8,400"\n' +
    '2026-07-08,IG,"A ""quoted"" post",300,25,12,9100\n'

  it('parses quoted fields, aliases, and formatted numbers', () => {
    const posts = postsFromCSV(csv)
    expect(posts).toHaveLength(2)
    expect(posts[0].platforms).toEqual(['x'])
    expect(posts[0].body).toBe('Hello, world')
    expect(posts[0].metrics?.x).toMatchObject({ likes: 120, comments: 10, shares: 5, impressions: 8400 })
    expect(posts[1].platforms).toEqual(['instagram'])
    expect(posts[1].body).toBe('A "quoted" post')
  })

  it('is idempotent: same row gives the same id', () => {
    const a = postsFromCSV(csv)
    const b = postsFromCSV(csv)
    expect(a.map(p => p.id)).toEqual(b.map(p => p.id))
    expect(new Set(a.map(p => p.id)).size).toBe(2)
  })
})

describe('postsFromXArchive', () => {
  const archive =
    'window.YTD.tweets.part0 = ' +
    JSON.stringify([
      {
        tweet: {
          id_str: '111',
          full_text: 'Shipping &amp; iterating &lt;fast&gt;',
          created_at: 'Wed Oct 10 20:19:24 +0000 2018',
          favorite_count: '42',
          retweet_count: '7',
        },
      },
      { tweet: { id_str: '222', full_text: 'RT @someone: reposted thing', created_at: 'Thu Oct 11 09:00:00 +0000 2018' } },
      {
        tweet: {
          id_str: '333',
          full_text: 'a reply',
          created_at: 'Fri Oct 12 09:00:00 +0000 2018',
          in_reply_to_status_id_str: '111',
          favorite_count: 3,
          retweet_count: 0,
        },
      },
    ])

  it('strips the window.YTD prefix and maps tweets', () => {
    const { posts, skippedRetweets } = postsFromXArchive(archive)
    expect(posts).toHaveLength(2)
    expect(skippedRetweets).toBe(1)
    expect(posts[0].id).toBe('x-111')
    expect(posts[0].body).toBe('Shipping & iterating <fast>')
    expect(posts[0].postedAt).toBe('2018-10-10T20:19:24.000Z')
    expect(posts[0].metrics?.x).toMatchObject({ likes: 42, shares: 7 })
    expect(posts[0].link).toBe('https://x.com/i/web/status/111')
  })

  it('tags replies', () => {
    const { posts } = postsFromXArchive(archive)
    expect(posts[1].tags).toContain('reply')
  })

  it('rejects unrecognized content', () => {
    expect(() => postsFromXArchive('{"not": "an array"}')).toThrow()
  })
})

/** Re-encode a string the way Instagram exports mangle it: UTF-8 bytes read as latin-1 code points. */
function mojibake(s: string): string {
  return [...new TextEncoder().encode(s)].map(b => String.fromCharCode(b)).join('')
}

describe('postsFromInstagramArchive', () => {
  it('maps posts and fixes mojibake captions', () => {
    const ts = 1690000000
    const json = JSON.stringify([
      { media: [{ creation_timestamp: ts, title: mojibake('Launch day 👋') }] },
      { title: 'Top-level caption', creation_timestamp: ts + 100, media: [] },
      { media: [] }, // no timestamp -> skipped
    ])
    const posts = postsFromInstagramArchive(json)
    expect(posts).toHaveLength(2)
    expect(posts[0].platforms).toEqual(['instagram'])
    expect(posts[0].postedAt).toBe(new Date(ts * 1000).toISOString())
    expect(posts[0].body).toBe('Launch day 👋')
    expect(posts[1].body).toBe('Top-level caption')
  })
})

describe('fixLatin1Utf8', () => {
  it('decodes latin-1 mojibake', () => {
    expect(fixLatin1Utf8(mojibake('don’t'))).toBe('don’t')
  })
  it('leaves clean strings alone', () => {
    expect(fixLatin1Utf8('already fine — with dash')).toBe('already fine — with dash')
  })
})
