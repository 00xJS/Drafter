import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { complete, nvidiaKeyOrder, resolveProvider } from '../../netlify/functions/lib/ai.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import aiFunction from '../../netlify/functions/ai.mjs'

// An optional second NVIDIA key, NVIDIA_API_KEY_2, spreads the load: the free
// tier is about 40 requests a minute per key. Work the server starts by itself
// (`background`: Sunday's draft, email-in's triage) tries it first, so the
// owner's own requests keep the main key's quota; a 429 or a 5xx from the key
// tried first is tried once on the other, never more; then the Anthropic
// fallback applies as before. With the second key unset, nothing changes.
// NVIDIA is a fetch stub that answers each key as a test says and records the
// key each call carried; the Anthropic SDK is replaced.

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

type Key = 'main' | 'second'
/** Each NVIDIA call: the key it carried, the model it asked for and where it went. */
let asked: { key: Key; model: string; url: string }[]
/** What NVIDIA answers each key, call by call; 200 once a key's list runs out. */
let answers: Record<Key, number[]>

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', MAIN)
  vi.stubEnv('NVIDIA_API_KEY_2', SECOND)
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('AI_PROVIDER', '')
  vi.stubEnv('NVIDIA_MODEL', '')
  claude.asked = 0
  asked = []
  answers = { main: [], second: [] }
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
        const key: Key | null = bearer === `Bearer ${MAIN}` ? 'main' : bearer === `Bearer ${SECOND}` ? 'second' : null
        if (!key) throw new Error('NVIDIA was asked with neither key')
        asked.push({ key, model: JSON.parse(String(init?.body)).model, url })
        const status = answers[key].shift() ?? 200
        return status === 200 ? Response.json({ choices: [{ message: { content: `from the ${key} key` } }] }) : Response.json({ error: { message: `HTTP ${status}` } }, { status })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const keys = () => asked.map(a => a.key)

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

  it('tries no other key on a 429: Claude, when it is set, is the one backup, as before', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
    answers.main = [429]
    expect(await complete({ prompt: 'x', background: true })).toEqual({ text: 'from Claude', provider: 'anthropic' })
    expect([keys(), claude.asked]).toEqual([['main'], 1])
  })

  it('and without Claude answers NVIDIA’s 429, as before', async () => {
    answers.main = [429]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 429, error: expect.stringMatching(/^NVIDIA rate limit hit/) })
    expect(keys()).toEqual(['main'])
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

  it('then the Anthropic fallback applies, as before', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
    answers.main = [503]
    answers.second = [503]
    expect(await complete({ prompt: 'x' })).toEqual({ text: 'from Claude', provider: 'anthropic' })
    expect([keys(), claude.asked]).toEqual([['main', 'second'], 1])
  })

  it('tries nothing else on the other key, and names the key that was rejected', async () => {
    answers.second = [401]
    expect(await complete({ prompt: 'x', background: true })).toEqual({ status: 502, upstream: 401, error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY_2 on the host.' })
    answers.main = [403]
    expect(await complete({ prompt: 'x' })).toMatchObject({ status: 502, error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.' })
    expect(keys()).toEqual(['second', 'main'])
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

  it('never hands either key to the page, even when one is rejected', async () => {
    answers.main = [401]
    const res = await askAi({ prompt: 'x' })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY on the host.' })
    expect(text).not.toContain(MAIN)
    expect(text).not.toContain(SECOND)
  })
})
