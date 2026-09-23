import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JOB_MAX_AGE_MS, JOB_PATH, readJob, signJob, siteOrigin, startJob } from '../../netlify/functions/lib/aijobs.mjs'

// The server's own AI work goes to a background function (lib/aijobs.mjs):
// only our functions may start it, with a signature made from a key derived
// from the service key, and starting one never holds up — or throws out of —
// the digest or the email webhook that asks for it.

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const SECRET = 'service-key'

describe('starting a job', () => {
  it('posts it to the background function, signed, and a request so made reads back as the job', async () => {
    const sent: Request[] = []
    const ok = await startJob({ type: 'triage', taskId: 'mail-1' }, {
      origin: 'https://site.test',
      secret: SECRET,
      now: () => 1_790_000_000_000,
      fetchImpl: async (input, init) => {
        sent.push(new Request(String(input), init))
        return new Response(null, { status: 202 })
      },
    })
    expect(ok).toBe(true)
    expect(sent[0].url).toBe(`https://site.test${JOB_PATH}`)
    expect(sent[0].headers.get('x-drafter-job-at')).toBe('1790000000000')
    expect(await readJob(sent[0], { secret: SECRET, now: 1_790_000_000_000 + 1_000 })).toEqual({ job: { type: 'triage', taskId: 'mail-1' } })
  })

  it('never throws: no address, no key, a refusal, a failure or no answer is false', async () => {
    vi.useFakeTimers()
    const job = { type: 'triage' }
    expect(await startJob(job, { origin: '', secret: SECRET, fetchImpl: async () => new Response(null, { status: 202 }) })).toBe(false)
    expect(await startJob(job, { origin: 'https://site.test', secret: '', fetchImpl: async () => new Response(null, { status: 202 }) })).toBe(false)
    expect(await startJob(job, { origin: 'https://site.test', secret: SECRET, fetchImpl: async () => new Response('no', { status: 500 }) })).toBe(false)
    expect(
      await startJob(job, {
        origin: 'https://site.test',
        secret: SECRET,
        fetchImpl: async () => {
          throw new TypeError('fetch failed')
        },
      }),
    ).toBe(false)
    let out: boolean | undefined
    startJob(job, {
      origin: 'https://site.test',
      secret: SECRET,
      timeoutMs: 1_000,
      fetchImpl: (_input, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    }).then(v => (out = v))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(out).toBe(false)
  })

  it('finds the site from Netlify’s address, else the request’s own', () => {
    vi.stubEnv('URL', '')
    vi.stubEnv('DEPLOY_PRIME_URL', '')
    expect(siteOrigin('https://drafterz.netlify.app')).toBe('https://drafterz.netlify.app')
    vi.stubEnv('URL', 'https://drafter.example.org/')
    expect(siteOrigin('https://drafterz.netlify.app')).toBe('https://drafter.example.org')
  })
})

describe('reading one', () => {
  const at = 1_790_000_000_000
  const make = (body: string, headers: Record<string, string>) => new Request(`https://site.test${JOB_PATH}`, { method: 'POST', headers, body })
  const signed = (body: string, when = at, secret = SECRET) => ({ 'x-drafter-job-at': String(when), 'x-drafter-job-sig': signJob(body, String(when), secret) })

  it('refuses one another key signed, one altered on the way, one too old, and one never signed', async () => {
    const body = JSON.stringify({ type: 'sunday-drafts', userIds: ['a'] })
    expect(await readJob(make(body, signed(body, at, 'other')), { secret: SECRET, now: at })).toEqual({ status: 401, error: 'not a job of ours' })
    expect(await readJob(make(body.replace('"a"', '"b"'), signed(body)), { secret: SECRET, now: at })).toEqual({ status: 401, error: 'not a job of ours' })
    expect(await readJob(make(body, signed(body)), { secret: SECRET, now: at + JOB_MAX_AGE_MS + 1 })).toEqual({ status: 401, error: 'not a job of ours' })
    expect(await readJob(make(body, {}), { secret: SECRET, now: at })).toEqual({ status: 401, error: 'not a job of ours' })
    expect(await readJob(make(body, signed(body)), { secret: SECRET, now: at + JOB_MAX_AGE_MS })).toEqual({ job: { type: 'sunday-drafts', userIds: ['a'] } })
  })

  it('signs with a key made from the service key, never with the service key itself', () => {
    const body = '{"type":"triage"}'
    const withTheKeyItself = createHmac('sha256', SECRET).update(`${at}.${body}`).digest('base64url')
    expect(signJob(body, String(at), SECRET)).not.toBe(withTheKeyItself)
    expect(signJob(body, String(at), SECRET)).toBe(signJob(body, String(at), SECRET))
  })

  it('is only for a POST, on a site with its key, carrying a job', async () => {
    expect(await readJob(new Request(`https://site.test${JOB_PATH}`), { secret: SECRET, now: at })).toEqual({ status: 405, error: 'Method not allowed' })
    expect(await readJob(make('{}', signed('{}')), { secret: '', now: at })).toEqual({ status: 501, error: 'not configured' })
    expect(await readJob(make('[1]', signed('[1]')), { secret: SECRET, now: at })).toEqual({ status: 400, error: 'not a job' })
  })
})
