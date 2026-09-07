import { describe, expect, it } from 'vitest'
import { withCors } from '../../netlify/functions/lib/cors.mjs'

const APP = 'capacitor://localhost'
const handler = withCors(async (req: Request) => Response.json({ ok: true, method: req.method }))

describe('CORS for the iOS shell', () => {
  it('answers the preflight the app sends before every API call', async () => {
    const res = await handler(new Request('https://site/api/push', { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': 'POST' } }), {})
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('stamps the real response for the app origin only', async () => {
    const fromApp = await handler(new Request('https://site/api/push', { headers: { origin: APP } }), {})
    expect(fromApp.headers.get('access-control-allow-origin')).toBe(APP)
    expect(await fromApp.json()).toEqual({ ok: true, method: 'GET' })

    const fromElsewhere = await handler(new Request('https://site/api/push', { headers: { origin: 'https://evil.example' } }), {})
    expect(fromElsewhere.headers.get('access-control-allow-origin')).toBeNull()
    expect(await fromElsewhere.json()).toEqual({ ok: true, method: 'GET' })
  })

  it('refuses a preflight from anywhere else', async () => {
    const res = await handler(new Request('https://site/api/push', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), {})
    expect(res.status).toBe(403)
  })

  it('leaves a redirect intact, since OAuth callbacks are redirects', async () => {
    const redirecting = withCors(async () => new Response(null, { status: 302, headers: { location: 'drafter://oauth?google=connected' } }))
    const res = await redirecting(new Request('https://site/api/google/callback', { headers: { origin: APP } }), {})
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('drafter://oauth?google=connected')
  })
})
