import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import householdFunction from '../../netlify/functions/household.mjs'

// A member's picture (v3.25) lives in user_settings, in no record, so the
// v3.18 storage policy — a housemate reads a bare-id photo only when a record
// they can read vouches for it — refused the other member's, and they drew
// initials. The policy stays as narrow as it is: /api/household signs a
// short-lived link to each member's picture, for the members of the caller's
// own household, and only for a picture the member uploaded themselves.

const household = householdFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const OWNER = '00000000-0000-0000-0000-00000000000a'
const MEMBER = '00000000-0000-0000-0000-00000000000b'
const HH = '00000000-0000-0000-0000-0000000000f1'

type Member = { id: string; avatar: string | null; avatarLink: { url: string; expiresAt: string } | null }

let calls: { method: string; path: string; body?: unknown }[]
let settings: { user_id: string; display_name: string | null; avatar_media_id: string | null }[]
/** Who uploaded each object in the media bucket, as public.media_owners answers. */
let owners: Record<string, string | null>
let signFails: boolean

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'sb_secret_service')
  calls = []
  settings = [
    { user_id: OWNER, display_name: 'Joseph', avatar_media_id: 'face-owner' },
    { user_id: MEMBER, display_name: 'Maria', avatar_media_id: 'face-member' },
  ]
  owners = { 'face-owner': OWNER, 'face-member': MEMBER, 'note-photo': OWNER }
  signFails = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path: url.pathname, body })
      if (url.pathname === '/auth/v1/user') return Response.json({ id: MEMBER, email: 'maria@example.test' })
      if (url.pathname === '/auth/v1/admin/users') return Response.json({ users: [OWNER, MEMBER].map(id => ({ id, email: `${id}@example.test` })) })
      if (url.pathname === '/rest/v1/user_settings') {
        const one = url.searchParams.get('user_id')
        return Response.json(one?.startsWith('eq.') ? settings.filter(s => `eq.${s.user_id}` === one) : settings)
      }
      if (url.pathname === '/rest/v1/household_invites') return Response.json([])
      if (url.pathname === '/rest/v1/household_members') {
        const rows = [
          { household_id: HH, user_id: OWNER, role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
          { household_id: HH, user_id: MEMBER, role: 'member', joined_at: '2026-01-02T00:00:00Z' },
        ]
        const one = url.searchParams.get('user_id')
        return Response.json(one ? rows.filter(r => `eq.${r.user_id}` === one) : rows)
      }
      if (url.pathname === '/rest/v1/households') return Response.json([{ id: HH, name: 'Home', created_by: OWNER }])
      if (url.pathname === '/rest/v1/rpc/media_owners') return Response.json(Object.fromEntries((body.p_names as string[]).filter(n => n in owners).map(n => [n, owners[n]])))
      if (url.pathname === '/storage/v1/object/sign/media') {
        if (signFails) return Response.json({ message: 'storage is down' }, { status: 503 })
        return Response.json((body.paths as string[]).map(path => ({ path, signedURL: `/object/sign/media/${path}?token=t-${path}`, error: null })))
      }
      throw new Error(`unexpected ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const status = async () => {
  const res = await household(new Request('https://site.test/api/household', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }) }))
  expect(res.status).toBe(200)
  return (await res.json()) as { members: Member[] }
}
const signed = () => calls.filter(c => c.path === '/storage/v1/object/sign/media')

describe('a member’s picture', () => {
  it('comes with a link, signed for an hour, that the other member can read it through', async () => {
    const before = Date.now()
    const { members } = await status()
    const joseph = members.find(m => m.id === OWNER)!
    expect(joseph.avatar).toBe('face-owner')
    expect(joseph.avatarLink!.url).toBe(`${SUPABASE}/storage/v1/object/sign/media/face-owner?token=t-face-owner`)
    const lasts = Date.parse(joseph.avatarLink!.expiresAt) - before
    expect(lasts).toBeGreaterThanOrEqual(3600_000 - 1000)
    expect(lasts).toBeLessThanOrEqual(3600_000 + 1000)
    expect(members.find(m => m.id === MEMBER)!.avatarLink!.url).toContain('/object/sign/media/face-member?token=')
    // one request for every picture, signed with the service key and never the caller's session
    expect(signed()).toHaveLength(1)
    expect(signed()[0].body).toEqual({ expiresIn: 3600, paths: ['face-owner', 'face-member'] })
  })

  it('is never signed for a picture its member did not upload: naming someone’s photo reads nothing', async () => {
    // Maria names, as her picture, a photo from one of Joseph's notes that he has since made private
    settings[1].avatar_media_id = 'note-photo'
    const { members } = await status()
    expect(members.find(m => m.id === MEMBER)).toMatchObject({ avatar: 'note-photo', avatarLink: null })
    expect(signed()[0].body).toEqual({ expiresIn: 3600, paths: ['face-owner'] })
    // naming the other member's picture as one's own borrows nothing either
    settings[1].avatar_media_id = 'face-owner'
    calls = []
    const borrowed = (await status()).members
    expect(borrowed.find(m => m.id === OWNER)!.avatarLink).not.toBeNull()
    expect(borrowed.find(m => m.id === MEMBER)).toMatchObject({ avatar: 'face-owner', avatarLink: null })
    // an object the service key wrote has no uploader, and is not signed either
    owners['face-owner'] = null
    calls = []
    expect((await status()).members.every(m => m.avatarLink === null)).toBe(true)
    expect(signed()).toEqual([])
  })

  it('asks nothing for a member with no picture, or a picture that is not a bare id', async () => {
    settings[0].avatar_media_id = null
    settings[1].avatar_media_id = 'personal/00000000-0000-0000-0000-00000000000b/x'
    const { members } = await status()
    expect(members.map(m => m.avatarLink)).toEqual([null, null])
    expect(calls.some(c => c.path === '/rest/v1/rpc/media_owners' || c.path.startsWith('/storage/'))).toBe(false)
  })

  it('without a link the member list still answers, and the pictures fall back to initials', async () => {
    signFails = true
    const { members } = await status()
    expect(members).toHaveLength(2)
    expect(members.every(m => m.avatarLink === null)).toBe(true)
  })
})
