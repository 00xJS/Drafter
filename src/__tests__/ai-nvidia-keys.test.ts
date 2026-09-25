import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { complete, nvidiaKeyOrder, resolveProvider } from '../../netlify/functions/lib/ai.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import aiFunction from '../../netlify/functions/ai.mjs'

// More NVIDIA keys — NVIDIA_API_KEY_2, NVIDIA_API_KEY_3 and on — spread the
// load: the free tier is about 40 requests a minute per key, and the owner can
// get as many keys as they like. Work the server starts by itself
// (`background`: Sunday's draft, email-in's triage) starts on the second, so
// the owner's own requests keep the main key's quota; a 429 or a 5xx from a
// key is tried on the next, on the same model, once per key, and so is a key
// NVIDIA rejects. There is no Anthropic fallback: NVIDIA keys only, whatever
// else the host has. With one key, nothing changes. NVIDIA is a fetch stub
// that answers each key as a test says and records the key each call carried;
// the Anthropic SDK is replaced, to count that it is never asked.

const claude = vi.hoisted(() => ({ asked: 0 }))
vi.mock('@anthropic-ai/sdk', () => {
  const create = async () => {
    claude.asked++
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'from Claude' }] }
  }
  return {
    default: class {
      messages = { create }
      beta = { messages: { create } }
    },
  }
})

type Handler = (req: Request) => Promise<Response>
const ai = aiFunction as Handler

const SUPABASE = 'https://db.example.test'
const NVIDIA = 'https://integrate.api.nvidia.com/v1/chat/completions'
const MAIN = 'nvapi-main-key-0000'
const SECOND = 'nvapi-second-key-1111'
const THIRD = 'nvapi-third-key-2222'

type Key = 'main' | 'second' | 'third'
/** Each NVIDIA call: the key it carried, the model it asked for and where it went. */
let asked: { key: Key; model: string; url: string }[]
/** What NVIDIA answers each key, call by call; 200 once a key's list runs out, and 0 for no answer at all. */
let answers: Record<Key, number[]>
/** The models each key's account can serve: every one, unless a test says otherwise. */
let serves: Record<Key, (model: string) => boolean>

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', MAIN)
  vi.stubEnv('NVIDIA_API_KEY_2', SECOND)
  vi.stubEnv('NVIDIA_API_KEY_3', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('AI_PROVIDER', '')
  vi.stubEnv('NVIDIA_MODEL', '')
  claude.asked = 0
  asked = []
  answers = { main: [], second: [], third: [] }
  serves = { main: () => true, second: () => true, third: () => true }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) {
        const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
        return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
      }
      if (url === NVIDIA) {
        const bearer = new Headers(init?.headers).get('authorization')
        const key: Key | null = bearer === `Bearer ${MAIN}` ? 'main' : bearer === `Bearer ${SECOND}` ? 'second' : bearer === `Bearer ${THIRD}` ? 'third' : null
        if (!key) throw new Error('NVIDIA was asked with none of the keys')
        const model: string = JSON.parse(String(init?.body)).model
        asked.push({ key, model, url })
        if (!serves[key](model)) return Response.json({ error: { message: `Function '${model}': Not found for account` } }, { status: 404 })
        const status = answers[key].shift() ?? 200
        // a connection dropped: fetch itself fails
        if (status === 0) throw new TypeError('fetch failed')
        return status === 200 ? Response.json({ choices: [{ message: { content: `from the ${key} key` } }] }) : Response.json({ error: { message: `HTTP ${status}` } }, { status })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const keys = () => asked.map(a => a.key)
/** console.error, silenced, to read what the calls logged. */
const logs = () => vi.spyOn(console, 'error').mockImplementation(() => {})
const logged = (spy: ReturnType<typeof logs>) => spy.mock.calls.map(c => String(c[0]))

describe('with NVIDIA_API_KEY_2 unset, nothing changes', () => {
  beforeEach(() => {
    vi.stubEnv('NVIDIA_API_KEY_2', '')
  })

  it('has the main key alone, for the owner’s requests and for background work', () => {
    expect(nvidiaKeyOrder()).toEqual(['NVIDIA_API_KEY'])
    expect(nvidiaKeyOrder({ background: true })).toEqual(['NVIDIA_API_KEY'])
  })

  it('asks on the main key either way', async () => {
    expect(await complete({ prompt: 'x' })).toEqual({ text: 'from the main key', provider: 'nvidia' })
    expect(await complete({ prompt: 'x', background: true })).toEqual({ text: 'from the main key', provider: 'nvidia' })
    expect(keys()).toEqual(['main', 'main'])
  })

  it('tries no other key on a 429, and never Claude, even with a Claude key on the host', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
    answers.main = [429]
    expect(await complete({ prompt: 'x', background: true })).toMatchObject({ status: 429, upstream: 429 })
    expect([keys(), claude.asked]).toEqual([['main'], 0])
  })

  it('and without Claude answers NVIDIA’s 429, as before', async () => {
    answers.main = [429]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 429, error: expect.stringMatching(/^NVIDIA rate limit hit/) })
    expect(keys()).toEqual(['main'])
  })

  it('answers a rejected key as before, and logs nothing new', async () => {
    const spy = logs()
    answers.main = [401]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 502, error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('with NVIDIA_API_KEY_2 set', () => {
  it('the owner’s request tries the main key first, and background work the second', async () => {
    expect(nvidiaKeyOrder()).toEqual(['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2'])
    expect(nvidiaKeyOrder({ background: true })).toEqual(['NVIDIA_API_KEY_2', 'NVIDIA_API_KEY'])
    expect(await complete({ prompt: 'x' })).toEqual({ text: 'from the main key', provider: 'nvidia' })
    expect(await complete({ prompt: 'x', background: true })).toEqual({ text: 'from the second key', provider: 'nvidia' })
    expect(keys()).toEqual(['main', 'second'])
  })

  it.each([429, 500, 502, 503])('a %i from the key tried first is tried once on the other', async status => {
    answers.main = [status]
    expect((await complete({ prompt: 'x' })).text).toBe('from the second key')
    answers.second = [status]
    expect((await complete({ prompt: 'x', background: true })).text).toBe('from the main key')
    expect(keys()).toEqual(['main', 'second', 'second', 'main'])
  })

  it('never more than once across keys: with both rate-limited and no Claude, the 429 comes back after two calls', async () => {
    answers.main = [429, 429]
    answers.second = [429, 429]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 429, error: expect.stringMatching(/^NVIDIA rate limit hit/) })
    expect(keys()).toEqual(['main', 'second'])
  })

  it('and no Anthropic fallback after them, a Claude key on the host or not', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
    answers.main = [503]
    answers.second = [503]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 502, upstream: 503 })
    expect([keys(), claude.asked]).toEqual([['main', 'second'], 0])
  })

  it('a key NVIDIA rejects is named in the log, and the other key answers in its place, whichever went first', async () => {
    const spy = logs()
    answers.second = [401]
    expect(await complete({ prompt: 'x', background: true })).toEqual({ text: 'from the main key', provider: 'nvidia' })
    answers.main = [403]
    expect(await complete({ prompt: 'x' })).toEqual({ text: 'from the second key', provider: 'nvidia' })
    expect(keys()).toEqual(['second', 'main', 'main', 'second'])
    // nobody sees the failure now, so the function's log is where a bad key shows
    expect(logged(spy)).toEqual(['ai: NVIDIA rejected the API key — check NVIDIA_API_KEY_2 on the host.', 'ai: NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.'])
  })

  it('with both keys rejected, the first key’s answer stands, and the log names both', async () => {
    const spy = logs()
    answers.main = [401]
    answers.second = [401]
    expect(await complete({ prompt: 'x' })).toEqual({ status: 502, upstream: 401, error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.' })
    expect(keys()).toEqual(['main', 'second'])
    expect(logged(spy)).toEqual([
      'ai: NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.',
      'ai: NVIDIA_API_KEY_2 could not take over from NVIDIA_API_KEY: NVIDIA rejected the API key — check NVIDIA_API_KEY_2 on the host.',
    ])
  })

  it('a 429 the other key cannot take over, because NVIDIA rejects that key, answers the 429: a busy key still reads as busy', async () => {
    const spy = logs()
    answers.main = [429]
    answers.second = [401]
    expect(await complete({ prompt: 'x' })).toEqual({ status: 429, upstream: 429, error: expect.stringMatching(/^NVIDIA rate limit hit/) })
    expect(keys()).toEqual(['main', 'second'])
    expect(logged(spy)).toEqual(['ai: NVIDIA_API_KEY_2 could not take over from NVIDIA_API_KEY: NVIDIA rejected the API key — check NVIDIA_API_KEY_2 on the host.'])
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(new RegExp(`${MAIN}|${SECOND}`))
  })

  it('so does a 5xx whose retry gets no answer at all, a Claude key on the host or not', async () => {
    const spy = logs()
    answers.main = [503]
    answers.second = [0]
    // plain words for the page; NVIDIA's own and the thrown error for the log
    const outage = { status: 502, upstream: 503, error: 'NVIDIA’s service had a problem (HTTP 503) — try again in a moment.' }
    expect(await complete({ prompt: 'x' })).toEqual(outage)
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
    answers.main = [503]
    answers.second = [0]
    expect(await complete({ prompt: 'x' })).toEqual(outage)
    expect([keys(), claude.asked]).toEqual([['main', 'second', 'main', 'second'], 0])
    const once = [
      expect.stringMatching(/^ai: NVIDIA answered \S+ on NVIDIA_API_KEY with HTTP 503: HTTP 503$/),
      'ai: the provider call threw: fetch failed',
      'ai: NVIDIA_API_KEY_2 could not take over from NVIDIA_API_KEY: The assistant’s provider could not be reached — try again in a moment.',
    ]
    expect(logged(spy)).toEqual([...once, ...once])
  })

  it('asks the same model at the same address on both keys', async () => {
    answers.main = [429]
    await complete({ prompt: 'x', json: true })
    expect(keys()).toEqual(['main', 'second'])
    expect(asked[1].model).toBe(asked[0].model)
    expect(asked.map(a => a.url)).toEqual([NVIDIA, NVIDIA])
  })

  it('counts one value set under both names as one key, never tried twice', async () => {
    vi.stubEnv('NVIDIA_API_KEY_2', MAIN)
    expect(nvidiaKeyOrder()).toEqual(['NVIDIA_API_KEY'])
    expect(nvidiaKeyOrder({ background: true })).toEqual(['NVIDIA_API_KEY_2'])
    answers.main = [429]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 429 })
    expect(keys()).toEqual(['main'])
  })
})

describe('AI_PROVIDER keeps its forcing', () => {
  it('anthropic: Claude alone, never either NVIDIA key, background work included', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
    expect(await complete({ prompt: 'x', background: true })).toEqual({ text: 'from Claude', provider: 'anthropic' })
    expect(keys()).toEqual([])
  })

  it('anthropic without its key is off, whichever NVIDIA keys are set', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    expect(resolveProvider()).toBeNull()
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 501 })
    expect(keys()).toEqual([])
  })

  it('nvidia: either key will do, and with neither it is off', async () => {
    vi.stubEnv('AI_PROVIDER', 'nvidia')
    vi.stubEnv('NVIDIA_API_KEY', '')
    expect(resolveProvider()).toBe('nvidia')
    expect((await complete({ prompt: 'x' })).text).toBe('from the second key')
    vi.stubEnv('NVIDIA_API_KEY_2', '')
    expect(resolveProvider()).toBeNull()
  })
})

describe('whether AI is configured counts either key', () => {
  it('the second key alone is enough, and no key at all is off', () => {
    vi.stubEnv('NVIDIA_API_KEY', '')
    expect(resolveProvider()).toBe('nvidia')
    vi.stubEnv('NVIDIA_API_KEY_2', '')
    expect(resolveProvider()).toBeNull()
  })
})

describe('/api/ai is the owner’s own request', () => {
  /** A signed-in call: a new account each time, so the per-account ceiling never meets the next test. */
  let accounts = 0
  const askAi = (body: Record<string, unknown>) =>
    ai(new Request('https://site.test/api/ai', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer good-k${++accounts}` }, body: JSON.stringify(body) }))

  it('goes on the main key first, whatever the page asks for', async () => {
    const res = await askAi({ prompt: 'x', background: true })
    expect(await res.json()).toEqual({ text: 'from the main key', provider: 'nvidia' })
    expect(keys()).toEqual(['main'])
  })

  it('never hands either key to the page, or to the log, even when both are rejected', async () => {
    const spy = logs()
    answers.main = [401]
    answers.second = [401]
    const res = await askAi({ prompt: 'x' })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.' })
    expect(text).not.toContain(MAIN)
    expect(text).not.toContain(SECOND)
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(new RegExp(`${MAIN}|${SECOND}`))
  })

  // Ask reads a rate limit as "busy, try again" and a rejected key as "not
  // available here": the main key's 429 must not come back as the second's 401
  it('a busy main key the second cannot stand in for still answers busy', async () => {
    logs()
    answers.main = [429]
    answers.second = [403]
    const res = await askAi({ prompt: 'x' })
    expect(res.status).toBe(429)
    expect((await res.json()).error).toMatch(/^NVIDIA rate limit hit/)
  })
})

// One key's account may not serve a model the other's does. Each key keeps the
// model it answers with, and the retry on the other key asks only the model the
// first key asked. These go last: the model each key answers with outlives a test.
describe('the model, key by key', () => {
  it('one key walking on to another model never moves the other key off its own', async () => {
    await complete({ prompt: 'x' })
    const model = asked[0].model
    serves.second = m => m !== model
    expect((await complete({ prompt: 'x', background: true })).text).toBe('from the second key')
    expect((await complete({ prompt: 'x' })).text).toBe('from the main key')
    expect(asked.map(a => [a.key, a.model === model])).toEqual([
      ['main', true],
      ['second', true],
      ['second', false],
      ['main', true],
    ])
  })

  it('the retry on the other key asks the model the first key asked, and no other: when it cannot, the first key’s answer stands', async () => {
    const spy = logs()
    serves.second = () => false
    answers.main = [429]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 429, upstream: 429 })
    expect(keys()).toEqual(['main', 'second'])
    expect(asked[1].model).toBe(asked[0].model)
    expect(logged(spy)).toEqual([
      expect.stringMatching(/^ai: no NVIDIA model answered on NVIDIA_API_KEY_2\. Tried: \S+ \(404\)\. The models this account can use are listed at /),
      'ai: NVIDIA_API_KEY_2 could not take over from NVIDIA_API_KEY: None of NVIDIA’s models would answer for this key — the site owner can set NVIDIA_MODEL on the host to one the account can use.',
    ])
  })
})

describe('as many keys as the host sets', () => {
  beforeEach(() => {
    vi.stubEnv('NVIDIA_API_KEY_3', THIRD)
  })

  it('takes NVIDIA_API_KEY_3 and on, main key first and then by number; background work starts on the second, the main key last', () => {
    vi.stubEnv('NVIDIA_API_KEY_10', 'nvapi-tenth-key-9999')
    // not a key's name: nothing else is read as a key
    vi.stubEnv('NVIDIA_API_KEY_0', 'nvapi-zero')
    vi.stubEnv('NVIDIA_API_KEY_X', 'nvapi-x')
    vi.stubEnv('NVIDIA_API_KEYS', 'nvapi-plural')
    expect(nvidiaKeyOrder()).toEqual(['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_10'])
    expect(nvidiaKeyOrder({ background: true })).toEqual(['NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_10', 'NVIDIA_API_KEY'])
  })

  it('counts one value under two names as one key', () => {
    vi.stubEnv('NVIDIA_API_KEY_4', SECOND)
    expect(nvidiaKeyOrder()).toEqual(['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3'])
  })

  it('walks on through every key while each is busy: two rate limits, and the third answers, on the same model', async () => {
    answers.main = [429]
    answers.second = [429]
    expect(await complete({ prompt: 'x' })).toEqual({ text: 'from the third key', provider: 'nvidia' })
    expect(keys()).toEqual(['main', 'second', 'third'])
    expect(new Set(asked.map(a => a.model)).size).toBe(1)
  })

  it('passes over a rejected key in the middle, and names it in the log', async () => {
    const spy = logs()
    answers.main = [429]
    answers.second = [401]
    expect(await complete({ prompt: 'x' })).toEqual({ text: 'from the third key', provider: 'nvidia' })
    expect(keys()).toEqual(['main', 'second', 'third'])
    expect(logged(spy)).toEqual(['ai: NVIDIA_API_KEY_2 could not take over from NVIDIA_API_KEY: NVIDIA rejected the API key — check NVIDIA_API_KEY_2 on the host.'])
  })

  it('with every key busy answers the last one’s 429, after one call on each', async () => {
    answers.main = [429]
    answers.second = [429]
    answers.third = [429]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 429, upstream: 429, error: expect.stringMatching(/^NVIDIA rate limit hit/) })
    expect(keys()).toEqual(['main', 'second', 'third'])
  })

  it('stops at an answer no other key can change, as with two', async () => {
    answers.main = [400]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 502, upstream: 400 })
    expect(keys()).toEqual(['main'])
  })

  it('is NVIDIA whatever else is set: Claude only where AI_PROVIDER names it', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
    expect(resolveProvider()).toBe('nvidia')
    for (const name of ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3']) vi.stubEnv(name, '')
    expect(resolveProvider()).toBe(null)
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    expect(resolveProvider()).toBe('anthropic')
  })
})

describe('the model that answered, for a caller that keeps it', () => {
  // the nightly recipe drafts keep it on each draft (lib/recipedrafts.mjs)
  it('is told once, as the model that wrote the answer, which is unchanged', async () => {
    const told: string[] = []
    expect(await complete({ prompt: 'x', onModel: m => told.push(m) })).toEqual({ text: 'from the main key', provider: 'nvidia' })
    expect(told).toEqual([asked.at(-1)!.model])
  })

  it('is the model that answered, not the first one tried, and the key that stood in for another', async () => {
    const told: string[] = []
    serves.main = model => model === 'openai/gpt-oss-20b'
    await complete({ prompt: 'x', onModel: m => told.push(m) })
    expect(told).toEqual(['openai/gpt-oss-20b'])
    // the second key busy: the main one answers background work, on the same model, and says so once
    serves.main = () => true
    serves.second = () => true
    answers.second = [503]
    told.length = 0
    expect(await complete({ prompt: 'x', background: true, onModel: m => told.push(m) })).toEqual({ text: 'from the main key', provider: 'nvidia' })
    expect(told).toEqual([asked.at(-1)!.model])
    expect(asked.at(-1)!.model).toBe(asked.at(-2)!.model)
  })

  it('is told nothing when nothing answered', async () => {
    const told: string[] = []
    const spy = logs()
    answers.main = [500]
    answers.second = [500]
    expect((await complete({ prompt: 'x', onModel: m => told.push(m) })).error).toBeTruthy()
    expect(told).toEqual([])
    spy.mockRestore()
  })
})
