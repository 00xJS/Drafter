import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A member's picture (v3.25) is in no record, so the storage policy — a
// housemate reads a photo only when a record they can read vouches for it —
// refused the other member's picture, and every face of theirs was initials.
// /api/household now signs a short-lived link to each member's picture, and
// the media cache fetches a picture it cannot download through that link,
// then keeps it on this device like any other photo.

const { rows, sb, fetched } = vi.hoisted(() => ({
  rows: new Map<string, { id: string; name: string; type: string; blob: Blob }>(),
  sb: { client: null as unknown, downloads: [] as string[] },
  fetched: [] as string[],
}))

vi.mock('../idb', () => ({
  idbGet: vi.fn(async (_store: string, key: string) => rows.get(key)),
  idbSet: vi.fn(async (_store: string, key: string, value: never) => void rows.set(key, value)),
  idbDel: vi.fn(async (_store: string, key: string) => void rows.delete(key)),
  idbAll: vi.fn(async () => [...rows.values()]),
}))
vi.mock('../supabase', () => ({ getSupabase: () => sb.client, storedUserId: () => null }))

const LINK = 'https://db.example.test/storage/v1/object/sign/media/face-maria?token=t1'
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString()

beforeEach(() => {
  rows.clear()
  sb.downloads = []
  fetched.length = 0
  // signed in, with a bucket that refuses a housemate's picture as the v3.18 policy does
  sb.client = {
    storage: {
      from: () => ({
        download: async (id: string) => {
          sb.downloads.push(id)
          return id === 'face-mine' ? { data: new Blob(['me'], { type: 'image/jpeg' }), error: null } : { data: null, error: { message: 'Object not found' } }
        },
      }),
    },
  }
  vi.resetModules()
  let made = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:face-${++made}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const kv = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input))
      return String(input) === LINK ? new Response(new Blob(['maria'], { type: 'image/jpeg' })) : new Response('expired', { status: 400 })
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a housemate’s picture', () => {
  it('comes through its signed link, and is kept on this device so the link is needed once', async () => {
    const media = await import('../media')
    // before the household's answer: the bucket refuses it, and the face is initials
    expect(await media.mediaURL('face-maria')).toBeNull()
    expect(sb.downloads).toEqual(['face-maria'])
    media.rememberMediaLinks([{ id: 'face-maria', url: LINK, expiresAt: inAnHour() }])
    const url = await media.mediaURL('face-maria')
    expect(url).toMatch(/^blob:/)
    expect(fetched).toEqual([LINK])
    // straight through the link: the bucket is not asked again for a picture it refuses
    expect(sb.downloads).toEqual(['face-maria'])
    expect(await rows.get('face-maria')!.blob.text()).toBe('maria')
    // a later launch finds it on this device, with no link and no network
    vi.resetModules()
    const again = await import('../media')
    expect(await again.mediaURL('face-maria')).toMatch(/^blob:/)
    expect(fetched).toEqual([LINK])
  })

  it('tells a face waiting on it that its link has come, and only that face', async () => {
    const media = await import('../media')
    const told: string[] = []
    const stop = media.onMediaLink('face-maria', () => told.push('maria'))
    media.onMediaLink('face-joseph', () => told.push('joseph'))
    media.rememberMediaLinks([{ id: 'face-maria', url: LINK, expiresAt: inAnHour() }])
    expect(told).toEqual(['maria'])
    stop()
    media.rememberMediaLinks([{ id: 'face-maria', url: LINK, expiresAt: inAnHour() }])
    expect(told).toEqual(['maria'])
  })

  it('ignores a link that has run out, or is not a web address, and falls back to the bucket', async () => {
    const media = await import('../media')
    const told: string[] = []
    media.onMediaLink('face-maria', () => told.push('maria'))
    media.rememberMediaLinks([
      { id: 'face-maria', url: LINK, expiresAt: new Date(Date.now() + 30_000).toISOString() },
      { id: 'face-maria', url: 'javascript:alert(1)', expiresAt: inAnHour() },
      { id: 'face-maria', url: LINK, expiresAt: 'not a date' },
    ])
    expect(told).toEqual([])
    expect(await media.mediaURL('face-maria')).toBeNull()
    expect(fetched).toEqual([])
    // one's own picture needs no link: the bucket gives it, as it always did
    expect(await media.mediaURL('face-mine')).toMatch(/^blob:/)
  })

  it('a link the storage refuses leaves the face as initials, and the bucket is still asked', async () => {
    const media = await import('../media')
    media.rememberMediaLinks([{ id: 'face-maria', url: `${LINK}-stale`, expiresAt: inAnHour() }])
    expect(await media.mediaURL('face-maria')).toBeNull()
    expect(fetched).toEqual([`${LINK}-stale`])
    expect(sb.downloads).toEqual(['face-maria'])
  })
})

describe('the household’s answer', () => {
  it('hands the media cache a link for every member with a picture', async () => {
    const { pictureLinks } = await import('../household')
    const expiresAt = inAnHour()
    const member = (id: string, avatar: string | null, link: { url: string; expiresAt: string } | null | undefined) => ({ id, email: '', displayName: id, avatar, avatarLink: link, role: 'member', joinedAt: '' })
    expect(
      pictureLinks({
        me: { id: 'a', email: '', displayName: null },
        household: null,
        members: [member('a', 'face-a', { url: LINK, expiresAt }), member('b', null, null), member('c', 'face-c', undefined)],
      }),
    ).toEqual([{ id: 'face-a', url: LINK, expiresAt }])
    expect(pictureLinks(null)).toEqual([])
  })

  it('once a picture has come through its link, every face of that member draws it', async () => {
    const media = await import('../media')
    const { MemberFace } = await import('../components/MemberFace')
    media.rememberMediaLinks([{ id: 'face-maria', url: LINK, expiresAt: inAnHour() }])
    const url = await media.mediaURL('face-maria')
    const html = renderToStaticMarkup(createElement(MemberFace, { name: 'Maria', avatar: 'face-maria', id: 'b', size: 28 }))
    expect(html).toContain(`<img class="member-face" src="${url}"`)
    // and a member whose picture never came is still their initials
    expect(renderToStaticMarkup(createElement(MemberFace, { name: 'Joseph Suckling', avatar: 'face-joseph', id: 'a' }))).toContain('>JS</span>')
  })
})
