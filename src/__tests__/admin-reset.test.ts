import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import adminFunction from '../../netlify/functions/admin.mjs'

// Admin → Users → Reset someone's password. Supabase keeps ONE recovery link
// per account: the email /recover sends carries it, and a link made with
// generate_link replaces it. Send reset email used to do both, one after the
// other, so every reset email arrived already cancelled by the link Admin
// showed underneath. The auth stand-in here keeps that one live link per
// account, which is what makes the difference visible.

const admin = adminFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const OWNER = '00000000-0000-0000-0000-00000000000a'
const MARIA = 'maria@example.test'
const SITE = 'https://drafter.example'

/** email -> the one recovery token Supabase will honour for that account. */
let live: Map<string, string>
/** What /recover mailed: to whom, the token in the link, and where the link returns to. */
let outbox: { to: string; token: string; redirectTo: string | null }[]
/** Every auth call, as `METHOD /path`. */
let calls: string[]
/** What /recover answers instead of sending, when set. */
let recoverFails: { status: number; msg: string } | null
let issued = 0

const works = (token: string) => [...live.values()].includes(token)
const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? ''

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  live = new Map()
  outbox = []
  calls = []
  recoverFails = null
  issued = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (url.pathname === '/auth/v1/user') return Response.json({ id: OWNER, email: 'owner@example.test' })
      if (url.pathname === '/rest/v1/app_config' && url.searchParams.get('key') === 'eq.owner_email') return Response.json([{ value: 'owner@example.test' }])
      calls.push(`${method} ${url.pathname}`)
      if (url.pathname === '/auth/v1/recover' && method === 'POST') {
        if (recoverFails) return Response.json({ msg: recoverFails.msg }, { status: recoverFails.status })
        const token = `recovery-${++issued}`
        // the account's last link, emailed or copied, stops working
        live.set(body.email, token)
        outbox.push({ to: body.email, token, redirectTo: url.searchParams.get('redirect_to') })
        return Response.json({})
      }
      if (url.pathname === '/auth/v1/admin/generate_link' && method === 'POST') {
        expect(body.type).toBe('recovery')
        const token = `recovery-${++issued}`
        live.set(body.email, token)
        // the raw endpoint returns the link's fields at the top level
        return Response.json({ action_link: `${SUPABASE}/auth/v1/verify?token=${token}&type=recovery`, hashed_token: token, verification_type: 'recovery', email: body.email })
      }
      throw new Error(`unexpected ${method} ${url.pathname}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const reset = (payload: Record<string, unknown>) =>
  admin(
    new Request(`${SITE}/api/admin`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resetPassword', ...payload }),
    }),
  )

describe('Admin → Send reset email', () => {
  it('mails the account its one live link, and makes no second link that would cancel it', async () => {
    const res = await reset({ email: MARIA, send: true, redirectTo: SITE })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: MARIA, mode: 'sent' })
    expect(calls).toEqual(['POST /auth/v1/recover'])
    expect(outbox).toEqual([{ to: MARIA, token: 'recovery-1', redirectTo: SITE }])
    expect(works(outbox[0].token), 'the emailed link still works when it arrives').toBe(true)
  })

  it('says Supabase would not send it, and makes no link instead', async () => {
    recoverFails = { status: 429, msg: 'For security purposes, you can only request this after 60 seconds.' }
    const res = await reset({ email: MARIA, send: true, redirectTo: SITE })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('Supabase would not send it: For security purposes, you can only request this after 60 seconds.')
    expect(calls).toEqual(['POST /auth/v1/recover'])
    expect(live.size).toBe(0)
  })
})

describe('Admin → Link only', () => {
  it('makes a link to copy, and sends nothing', async () => {
    const res = await reset({ email: MARIA })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ email: MARIA, actionLink: expect.stringContaining('/auth/v1/verify?token='), mode: 'link' })
    expect(calls).toEqual(['POST /auth/v1/admin/generate_link'])
    expect(outbox).toEqual([])
    expect(works(tokenOf(body.actionLink))).toBe(true)
  })

  it('after an email, cancels the link in it: why Admin asks before making one', async () => {
    await reset({ email: MARIA, send: true, redirectTo: SITE })
    const copied = await (await reset({ email: MARIA })).json()
    expect(works(outbox[0].token), 'the emailed link').toBe(false)
    expect(works(tokenOf(copied.actionLink)), 'the copied link').toBe(true)
  })
})
