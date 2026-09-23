import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ImportError,
  fetchPage,
  findRecipes,
  importRecipe,
  isPublicAddress,
  jsonLdBlocks,
  nodeTransport,
  pageTitle,
  parseImportUrl,
  readableText,
  recipeFromHtml,
  recipeImportHandler,
} from '../../netlify/functions/lib/recipeimport.mjs'
import type { Resolver, Transport, TransportResponse } from '../../netlify/functions/lib/recipeimport.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import recipeImportFunction from '../../netlify/functions/recipe-import.mjs'

// Import from a link: the server fetches a page a person chose, so the fetch
// must never reach anything but the public internet (the SSRF guard), and what
// it reads must come out as the app's own recipe shape. Every test here runs
// without a network: the resolver and the transport are fakes, except where a
// local server proves the real transport connects to the address it was given.

// ---- fixtures: pages as recipe sites write them ------------------------------------

/** Allrecipes-style: a Yoast @graph, `@type` as an array, entities in the strings, a yield array. */
const ALLRECIPES = `<!doctype html><html><head><title>Chicken &amp; Rice Casserole | Allrecipes</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"Allrecipes"},
  {"@type":"WebPage","name":"Chicken &amp; Rice Casserole"},
  {"@type":["Recipe"],"name":"Chicken &amp; Rice Casserole","recipeYield":["6","6 servings"],
   "recipeIngredient":["1 &frac12; cups long-grain white rice","2 (10.5 ounce) cans condensed cream of chicken soup","1 1/2 lbs. boneless, skinless chicken breasts, cubed","1 cup shredded Cheddar cheese","Salt and pepper to taste"],
   "recipeInstructions":[{"@type":"HowToStep","text":"Preheat the oven to 350 degrees F (175 degrees C)."},{"@type":"HowToStep","text":"Stir rice, soup and 2 cups water together in a 9x13-inch baking dish.&nbsp;"},{"@type":"HowToStep","name":"Top","text":"Lay the chicken on top and cover with foil."},{"@type":"HowToStep","text":"Bake for 1 hour, then sprinkle with Cheddar."}]}
]}
</script></head><body><nav>Home · Dinners</nav><main><h1>Chicken &amp; Rice Casserole</h1></main></body></html>`

/** NYT Cooking-style: HowToSection groups of HowToSteps, a string yield, a sized can. */
const NYT = `<html><head>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"Recipe","name":"Coconut Chicken Curry","recipeYield":"4 servings","recipeIngredient":["1 (14-ounce) can coconut milk","2 tablespoons curry powder","1 large onion, finely chopped","4 garlic cloves, minced","1½ pounds chicken thighs"],"recipeInstructions":[{"@type":"HowToSection","name":"For the base","itemListElement":[{"@type":"HowToStep","text":"Heat the oil in a large pot."},{"@type":"HowToStep","text":"Cook the onion until soft, 8 minutes."}]},{"@type":"HowToSection","name":"For the curry:","itemListElement":[{"@type":"HowToStep","text":"Add the curry powder and garlic."},{"@type":"HowToStep","text":"Pour in the coconut milk, add the chicken and simmer 25 minutes."}]}]}</script>
</head><body><p>Coconut Chicken Curry</p></body></html>`

/** A hand-rolled page: `@type` at the top level, the method as one string, and JSON a strict parser refuses. */
const PLAIN = `<html><head><script type='application/ld+json'>
{"@context": "https://schema.org", "@type": "Recipe", "name": "Weeknight Chili",
 "recipeIngredient": ["1 lb ground beef", "1 onion, diced", "2 cans kidney beans, drained",],
 "recipeInstructions": "1. Brown the beef with the onion.
2. Add the beans and a can of tomatoes.
3. Simmer for 30 minutes.",
}
</script></head><body></body></html>`

/** No Recipe data at all: the text is all there is. */
const NO_JSON_LD = `<!doctype html><html><head><title>Grandma's Meatballs | The Family Kitchen</title>
<style>.x{color:red}</style><script>console.log("tracking")</script></head>
<body><header>The Family Kitchen — Subscribe!</header><nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main><article><h1>Grandma&#39;s Meatballs</h1><p>These are the meatballs we grew up on, and they freeze well.</p>
<h2>Ingredients</h2><ul><li>1 lb ground beef</li><li>1 egg</li><li>1/2 cup breadcrumbs</li></ul>
<h2>Method</h2><ol><li>Mix everything together.</li><li>Roll into balls and bake at 400&deg;F for 20 minutes.</li></ol>
<!-- ad slot --></article></main><aside>Popular: Tacos</aside><footer>© The Family Kitchen</footer></body></html>`

// ---- fakes ---------------------------------------------------------------------------

type Calls = { url: string; address: string }[]

async function* chunks(...parts: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield typeof p === 'string' ? Buffer.from(p) : p
}

const page = (body: string | Buffer, headers: Record<string, string> = {}): TransportResponse => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body: chunks(body),
})
const redirect = (location: string, status = 302): TransportResponse => ({ status, headers: { location }, body: chunks('') })

/** A resolver from a table of names; anything else does not exist. */
function resolver(table: Record<string, string[]>, asked: string[] = []): Resolver {
  return async host => {
    asked.push(host)
    const found = table[host]
    if (!found) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    return found.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

/** A transport answering by URL, noting every request and the address it was sent to. */
function transport(routes: Record<string, () => TransportResponse | Promise<TransportResponse>>, calls: Calls = []): Transport {
  return async ({ url, address }) => {
    calls.push({ url: url.toString(), address })
    const route = routes[url.toString()]
    if (!route) throw new Error(`no route for ${url}`)
    return route()
  }
}

const PUBLIC = { 'recipes.example.com': ['93.184.216.34'], 'cdn.example.org': ['2606:4700::6810:84e5'] }

async function importError(p: Promise<unknown>): Promise<ImportError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError)
    return e as ImportError
  }
  throw new Error('expected the import to be refused')
}

// ---- the link --------------------------------------------------------------------------

describe('parseImportUrl: only a web page', () => {
  it('takes http and https, and drops the fragment', () => {
    expect(parseImportUrl('https://recipes.example.com/r/42#step-3').toString()).toBe('https://recipes.example.com/r/42')
    expect(parseImportUrl('  http://recipes.example.com:8080/x  ').port).toBe('8080')
  })

  it('refuses every other scheme', () => {
    for (const bad of ['ftp://recipes.example.com/r', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<p>hi</p>', 'gopher://recipes.example.com/']) {
      expect(() => parseImportUrl(bad), bad).toThrow(ImportError)
      try {
        parseImportUrl(bad)
      } catch (e) {
        expect((e as ImportError).status).toBe(400)
      }
    }
  })

  it('refuses nonsense, credentials and ports a web page does not use', () => {
    for (const bad of ['', 'not a link', 'https://user:secret@recipes.example.com/', 'http://recipes.example.com:22/', 'http://recipes.example.com:6379/', `https://recipes.example.com/${'x'.repeat(3000)}`]) {
      expect(() => parseImportUrl(bad), bad).toThrow(ImportError)
    }
  })
})

describe('isPublicAddress: the SSRF guard', () => {
  it('refuses private, loopback, link-local, CGNAT and other special IPv4 ranges', () => {
    const refused = [
      '0.0.0.0',
      '10.0.0.5',
      '100.64.0.1',
      '100.100.100.200', // Alibaba's metadata
      '127.0.0.1',
      '127.9.9.9',
      '169.254.169.254', // AWS, Google Cloud, Azure metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.192', // Oracle's metadata
      '192.0.2.10',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ]
    expect(refused.filter(isPublicAddress)).toEqual([])
  })

  it('refuses the same in IPv6, IPv4 dressed as IPv6 included', () => {
    const refused = [
      '::',
      '::1',
      'fe80::1',
      'fe80::1%en0',
      'fc00::1',
      'fd00:ec2::254', // AWS's IPv6 metadata
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      '::ffff:10.0.0.1',
      '::ffff:0:10.0.0.1',
      '::127.0.0.1',
      '64:ff9b::169.254.169.254', // NAT64
      '64:ff9b::a9fe:a9fe',
      '2001:db8::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      '2002:c0a8:0101::1', // 6to4 around 192.168.1.1
      '100::1',
      '[::1]',
    ]
    expect(refused.filter(isPublicAddress)).toEqual([])
  })

  it('lets public addresses of both families through', () => {
    for (const ok of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700::6810:84e5', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
      expect(isPublicAddress(ok), ok).toBe(true)
    }
  })

  it('is never a name', () => {
    expect(isPublicAddress('localhost')).toBe(false)
    expect(isPublicAddress('recipes.example.com')).toBe(false)
  })
})

// ---- the fetch ---------------------------------------------------------------------------

describe('fetchPage', () => {
  it('fetches a public page from the address it checked', async () => {
    const calls: Calls = []
    const got = await fetchPage(parseImportUrl('https://recipes.example.com/r/1'), {
      resolve: resolver(PUBLIC),
      transport: transport({ 'https://recipes.example.com/r/1': () => page('<p>hello</p>') }, calls),
    })
    expect(got.html).toBe('<p>hello</p>')
    expect(calls).toEqual([{ url: 'https://recipes.example.com/r/1', address: '93.184.216.34' }])
  })

  it('refuses a name that resolves to a private address, before any request', async () => {
    const calls: Calls = []
    const err = await importError(
      fetchPage(parseImportUrl('http://intranet.example.com/'), { resolve: resolver({ 'intranet.example.com': ['10.0.0.5'] }), transport: transport({}, calls) }),
    )
    expect(err.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('refuses a name when any of its answers is private', async () => {
    const calls: Calls = []
    const err = await importError(
      fetchPage(parseImportUrl('http://both.example.com/'), {
        resolve: resolver({ 'both.example.com': ['93.184.216.34', '127.0.0.1'] }),
        transport: transport({ 'http://both.example.com/': () => page('x') }, calls),
      }),
    )
    expect(err.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('refuses addresses written into the link, however they are spelt, without asking DNS', async () => {
    const asked: string[] = []
    const calls: Calls = []
    for (const link of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00:ec2::254]/']) {
      const err = await importError(fetchPage(parseImportUrl(link), { resolve: resolver({}, asked), transport: transport({}, calls) }))
      expect(err.status, link).toBe(403)
    }
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  it('follows a redirect to another public host, checking that host too', async () => {
    const asked: string[] = []
    const calls: Calls = []
    const got = await fetchPage(parseImportUrl('https://recipes.example.com/short'), {
      resolve: resolver(PUBLIC, asked),
      transport: transport(
        {
          'https://recipes.example.com/short': () => redirect('https://cdn.example.org/recipe/9', 301),
          'https://cdn.example.org/recipe/9': () => page('<p>moved</p>'),
        },
        calls,
      ),
    })
    expect(got.url.toString()).toBe('https://cdn.example.org/recipe/9')
    expect(asked).toEqual(['recipes.example.com', 'cdn.example.org'])
    expect(calls.map(c => c.address)).toEqual(['93.184.216.34', '2606:4700::6810:84e5'])
  })

  it('follows a relative redirect on the same host', async () => {
    const got = await fetchPage(parseImportUrl('https://recipes.example.com/a'), {
      resolve: resolver(PUBLIC),
      transport: transport({ 'https://recipes.example.com/a': () => redirect('/b', 307), 'https://recipes.example.com/b': () => page('b') }),
    })
    expect(got.html).toBe('b')
  })

  it('refuses a redirect to a private address, and never makes that request', async () => {
    const calls: Calls = []
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/r'), {
        resolve: resolver(PUBLIC),
        transport: transport({ 'https://recipes.example.com/r': () => redirect('http://169.254.169.254/latest/meta-data/iam/') }, calls),
      }),
    )
    expect(err.status).toBe(403)
    expect(calls).toHaveLength(1)
  })

  it('refuses a redirect to a name that resolves privately', async () => {
    const calls: Calls = []
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/r'), {
        resolve: resolver({ ...PUBLIC, 'rebind.example.net': ['192.168.0.10'] }),
        transport: transport({ 'https://recipes.example.com/r': () => redirect('http://rebind.example.net/admin') }, calls),
      }),
    )
    expect(err.status).toBe(403)
    expect(calls).toHaveLength(1)
  })

  it('refuses a redirect to any other scheme', async () => {
    for (const location of ['file:///etc/passwd', 'ftp://recipes.example.com/x', 'javascript:alert(1)']) {
      const err = await importError(
        fetchPage(parseImportUrl('https://recipes.example.com/r'), { resolve: resolver(PUBLIC), transport: transport({ 'https://recipes.example.com/r': () => redirect(location) }) }),
      )
      expect(err.status, location).toBe(400)
    }
  })

  it('follows three redirects and no more', async () => {
    const calls: Calls = []
    const loop: Record<string, () => TransportResponse> = {}
    for (let i = 0; i < 6; i++) loop[`https://recipes.example.com/${i}`] = () => redirect(`https://recipes.example.com/${i + 1}`)
    const err = await importError(fetchPage(parseImportUrl('https://recipes.example.com/0'), { resolve: resolver(PUBLIC), transport: transport(loop, calls) }))
    expect(err.message).toMatch(/redirects too many times/)
    expect(calls).toHaveLength(4)
    // …and three is fine
    const three = await fetchPage(parseImportUrl('https://recipes.example.com/0'), {
      resolve: resolver(PUBLIC),
      transport: transport({ ...loop, 'https://recipes.example.com/3': () => page('arrived') }),
    })
    expect(three.html).toBe('arrived')
  })

  it('reads web pages only', async () => {
    for (const type of ['application/pdf', 'image/png', 'application/json', '']) {
      const err = await importError(
        fetchPage(parseImportUrl('https://recipes.example.com/f'), { resolve: resolver(PUBLIC), transport: transport({ 'https://recipes.example.com/f': () => page('%PDF', { 'content-type': type }) }) }),
      )
      expect(err.status, type).toBe(415)
    }
    const xhtml = await fetchPage(parseImportUrl('https://recipes.example.com/x'), {
      resolve: resolver(PUBLIC),
      transport: transport({ 'https://recipes.example.com/x': () => page('<p/>', { 'content-type': 'application/xhtml+xml' }) }),
    })
    expect(xhtml.html).toBe('<p/>')
  })

  it('refuses a page that says it is too big, without reading it', async () => {
    let read = false
    const body = (async function* () {
      read = true
      yield Buffer.from('x')
    })()
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/big'), {
        resolve: resolver(PUBLIC),
        transport: transport({ 'https://recipes.example.com/big': () => ({ status: 200, headers: { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) }, body }) }),
      }),
    )
    expect(err.status).toBe(413)
    expect(read).toBe(false)
  })

  it('stops reading a body the moment it passes the cap, and lets the stream go', async () => {
    let yielded = 0
    let finished = false
    const body = (async function* () {
      try {
        for (;;) {
          yielded++
          yield Buffer.alloc(512, 97)
        }
      } finally {
        finished = true
      }
    })()
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/endless'), {
        resolve: resolver(PUBLIC),
        maxBytes: 2048,
        transport: transport({ 'https://recipes.example.com/endless': () => ({ status: 200, headers: { 'content-type': 'text/html' }, body }) }),
      }),
    )
    expect(err.status).toBe(413)
    expect(yielded).toBe(5)
    await new Promise(r => setTimeout(r, 0))
    expect(finished).toBe(true)
  })

  it('holds to two megabytes by default', async () => {
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/huge'), {
        resolve: resolver(PUBLIC),
        transport: transport({ 'https://recipes.example.com/huge': () => page(Buffer.alloc(2 * 1024 * 1024 + 1, 97)) }),
      }),
    )
    expect(err.status).toBe(413)
  })

  it('gives up on a site that never answers', async () => {
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/slow'), {
        resolve: resolver(PUBLIC),
        timeoutMs: 30,
        transport: transport({ 'https://recipes.example.com/slow': () => new Promise<TransportResponse>(() => {}) }),
      }),
    )
    expect(err.status).toBe(504)
  })

  it('gives up on a body that stalls half way', async () => {
    const body = (async function* () {
      yield Buffer.from('<p>half')
      await new Promise(() => {})
    })()
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/stall'), {
        resolve: resolver(PUBLIC),
        timeoutMs: 30,
        transport: transport({ 'https://recipes.example.com/stall': () => ({ status: 200, headers: { 'content-type': 'text/html' }, body }) }),
      }),
    )
    expect(err.status).toBe(504)
  })

  it('gives up on a name that takes too long to resolve', async () => {
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/'), { resolve: () => new Promise(() => {}), timeoutMs: 30, transport: transport({}) }),
    )
    expect(err.status).toBe(504)
  })

  it('says what the site answered when it is not a page', async () => {
    const err = await importError(
      fetchPage(parseImportUrl('https://recipes.example.com/gone'), {
        resolve: resolver(PUBLIC),
        transport: transport({ 'https://recipes.example.com/gone': () => ({ status: 404, headers: { 'content-type': 'text/html' }, body: chunks('nope') }) }),
      }),
    )
    expect(err.message).toMatch(/404/)
  })

  it('says so when the site does not exist', async () => {
    const err = await importError(fetchPage(parseImportUrl('https://nowhere.example.com/'), { resolve: resolver({}), transport: transport({}) }))
    expect(err.status).toBe(502)
    expect(err.message).toMatch(/Couldn’t find that site/)
  })

  it('reads the character set the page declares', async () => {
    const got = await fetchPage(parseImportUrl('https://recipes.example.com/latin'), {
      resolve: resolver(PUBLIC),
      transport: transport({ 'https://recipes.example.com/latin': () => page(Buffer.from([0x63, 0x61, 0x66, 0xe9]), { 'content-type': 'text/html; charset=windows-1252' }) }),
    })
    expect(got.html).toBe('café')
  })
})

describe('the real transport', () => {
  let server: ReturnType<typeof createServer>
  let port = 0
  const seen: { host?: string; path?: string }[] = []

  beforeEach(async () => {
    seen.length = 0
    server = createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url })
      if (req.url === '/hang') return
      if (req.url === '/hop') {
        res.writeHead(302, { location: '/zipped' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(gzipSync('<h1>Zipped pie</h1>'))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  it('connects to the checked address whatever the name would resolve to, and says the name to the site', async () => {
    // recipes.invalid resolves nowhere: reaching the server proves the connection went to the address given
    const res = await nodeTransport({
      url: new URL(`http://recipes.invalid:${port}/zipped`),
      address: '127.0.0.1',
      family: 4,
      signal: new AbortController().signal,
      headers: { accept: 'text/html' },
    })
    const parts: Buffer[] = []
    for await (const chunk of res.body) parts.push(Buffer.from(chunk))
    expect(res.status).toBe(200)
    expect(Buffer.concat(parts).toString()).toBe('<h1>Zipped pie</h1>')
    expect(seen).toEqual([{ host: `recipes.invalid:${port}`, path: '/zipped' }])
  })

  it('carries a whole fetch, decompressed, when the address is allowed', async () => {
    const asked: string[] = []
    const got = await fetchPage(new URL(`http://recipes.invalid:${port}/zipped`), {
      resolve: resolver({ 'recipes.invalid': ['127.0.0.1'] }, asked),
      // loopback is refused in every real import; only this test lets it through, to reach its own server
      isAllowed: () => true,
    })
    expect(got.html).toBe('<h1>Zipped pie</h1>')
    expect(asked).toEqual(['recipes.invalid'])
  })

  it('re-checks a redirect before following it: this one points at a port a web page does not use', async () => {
    const err = await importError(fetchPage(new URL(`http://recipes.invalid:${port}/hop`), { resolve: resolver({ 'recipes.invalid': ['127.0.0.1'] }), isAllowed: () => true }))
    expect(err.status).toBe(400)
    expect(seen.map(s => s.path)).toEqual(['/hop'])
  })

  it('refuses the loopback server itself when nothing overrides the guard', async () => {
    const err = await importError(fetchPage(new URL(`http://recipes.invalid:${port}/zipped`), { resolve: resolver({ 'recipes.invalid': ['127.0.0.1'] }) }))
    expect(err.status).toBe(403)
    expect(seen).toEqual([])
  })

  it('lets go of a site that never answers', async () => {
    const err = await importError(fetchPage(new URL(`http://recipes.invalid:${port}/hang`), { resolve: resolver({ 'recipes.invalid': ['127.0.0.1'] }), isAllowed: () => true, timeoutMs: 100 }))
    expect(err.status).toBe(504)
  })
})

// ---- reading the page --------------------------------------------------------------------

describe('reading schema.org Recipe data', () => {
  it('finds the Recipe in an Allrecipes-style @graph, with @type as an array', () => {
    const r = recipeFromHtml(ALLRECIPES)!
    expect(r.name).toBe('Chicken & Rice Casserole')
    expect(r.servings).toBe(6)
    expect(r.ingredients).toEqual([
      { name: 'long-grain white rice', qty: 1.5, unit: 'cup' },
      { name: 'condensed cream of chicken soup', qty: 2, unit: 'can' },
      { name: 'boneless, skinless chicken breasts', qty: 1.5, unit: 'lb' },
      { name: 'shredded Cheddar cheese', qty: 1, unit: 'cup' },
      { name: 'Salt and pepper' },
    ])
    expect(r.steps).toEqual([
      'Preheat the oven to 350 degrees F (175 degrees C).',
      'Stir rice, soup and 2 cups water together in a 9x13-inch baking dish.',
      'Lay the chicken on top and cover with foil.',
      'Bake for 1 hour, then sprinkle with Cheddar.',
    ])
  })

  it('reads NYT-style HowToSections, naming each section at its first step', () => {
    const r = recipeFromHtml(NYT)!
    expect(r.name).toBe('Coconut Chicken Curry')
    expect(r.servings).toBe(4)
    expect(r.ingredients).toEqual([
      { name: 'coconut milk', qty: 1, unit: 'can' },
      { name: 'curry powder', qty: 2, unit: 'tbsp' },
      { name: 'onion', qty: 1 },
      { name: 'garlic', qty: 4, unit: 'clove' },
      { name: 'chicken thighs', qty: 1.5, unit: 'lb' },
    ])
    expect(r.steps).toEqual([
      'For the base: Heat the oil in a large pot.',
      'Cook the onion until soft, 8 minutes.',
      'For the curry: Add the curry powder and garlic.',
      'Pour in the coconut milk, add the chicken and simmer 25 minutes.',
    ])
  })

  it('reads a method written as one string, from JSON a strict parser would refuse', () => {
    const r = recipeFromHtml(PLAIN)!
    expect(r.name).toBe('Weeknight Chili')
    expect(r.servings).toBeUndefined()
    expect(r.ingredients).toEqual([
      { name: 'ground beef', qty: 1, unit: 'lb' },
      { name: 'onion', qty: 1 },
      { name: 'kidney beans', qty: 2, unit: 'can' },
    ])
    expect(r.steps).toEqual(['Brown the beef with the onion.', 'Add the beans and a can of tomatoes.', 'Simmer for 30 minutes.'])
  })

  it('finds a Recipe at the top level, in a top-level array, under mainEntity, or by its full URL type', () => {
    expect(findRecipes({ '@type': 'Recipe', name: 'a' })).toHaveLength(1)
    expect(findRecipes([{ '@type': 'Organization' }, { '@type': 'Recipe', name: 'b' }])).toHaveLength(1)
    expect(findRecipes({ '@type': 'WebPage', mainEntity: { '@type': 'http://schema.org/Recipe', name: 'c' } })).toHaveLength(1)
    expect(findRecipes({ '@type': 'NewsArticle' })).toEqual([])
  })

  it('reads every JSON-LD block, skipping the ones that do not parse', () => {
    const html = `<script type="application/ld+json">{"a":1}</script><script type="application/ld+json">{nope</script><script>var x = 1</script><script type="application/ld+json">[2]</script>`
    expect(jsonLdBlocks(html)).toEqual([{ a: 1 }, [2]])
  })
})

describe('the readable text, when a page has no Recipe data', () => {
  it('keeps the recipe and drops scripts, styles, navigation, header, footer and asides', () => {
    const text = readableText(NO_JSON_LD)
    expect(text).toContain('Grandma\'s Meatballs')
    expect(text).toContain('• 1/2 cup breadcrumbs')
    expect(text).toContain('Roll into balls and bake at 400°F for 20 minutes.')
    for (const gone of ['tracking', 'color:red', 'Subscribe', 'About', 'Popular: Tacos', '©', 'ad slot']) expect(text, gone).not.toContain(gone)
  })

  it('is capped', () => {
    expect(readableText(`<p>${'word '.repeat(10_000)}</p>`, 500).length).toBeLessThanOrEqual(500)
  })

  it('stays quick on a page of tags that never close', () => {
    const hostile = '<a<script<style'.repeat(60_000)
    const started = Date.now()
    readableText(hostile)
    recipeFromHtml(hostile)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('names the page without the site after the bar', () => {
    expect(pageTitle(NO_JSON_LD)).toBe('Grandma\'s Meatballs')
    expect(pageTitle('<meta property="og:title" content="Best Tacos &amp; Salsa"><title>ignored</title>')).toBe('Best Tacos & Salsa')
  })
})

describe('importRecipe', () => {
  const importing = (html: string, url = 'https://recipes.example.com/r') => importRecipe(url, { resolve: resolver(PUBLIC), transport: transport({ [url]: () => page(html) }) })

  it('answers the recipe and where it came from', async () => {
    const got = await importing(ALLRECIPES, 'https://recipes.example.com/recipe/123/chicken-rice/')
    expect(got).toMatchObject({ sourceUrl: 'https://recipes.example.com/recipe/123/chicken-rice/', recipe: { name: 'Chicken & Rice Casserole', servings: 6 } })
  })

  it('answers the page’s text when it describes no recipe, for the app to read with ✨', async () => {
    const got = await importing(NO_JSON_LD)
    expect(got).toMatchObject({ title: 'Grandma\'s Meatballs', sourceUrl: 'https://recipes.example.com/r' })
    expect('text' in got && got.text).toContain('1 lb ground beef')
  })

  it('falls back to the text when the Recipe data has neither ingredients nor steps', async () => {
    const empty = NO_JSON_LD.replace('</head>', '<script type="application/ld+json">{"@type":"Recipe","name":"Meatballs"}</script></head>')
    const got = await importing(empty)
    expect(got).toMatchObject({ title: 'Meatballs' })
    expect('text' in got && got.text).toContain('Mix everything together.')
  })

  it('says so when a page has nothing to read', async () => {
    const err = await importError(importing('<html><body><script>x()</script></body></html>'))
    expect(err.status).toBe(422)
  })
})

// ---- the endpoint ------------------------------------------------------------------------

describe('/api/recipe-import', () => {
  const SUPABASE = 'https://db.example.test'

  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', SUPABASE)
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === `${SUPABASE}/auth/v1/user`) {
          const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
          return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
        }
        throw new Error(`unexpected fetch ${String(input)}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const post = (handler: (req: Request) => Promise<Response>, body: unknown, token?: string, headers: Record<string, string> = {}) =>
    handler(
      new Request('https://site.test/api/recipe-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: JSON.stringify(body),
      }),
    )

  const fake = (limit?: number) =>
    recipeImportHandler({ limit, resolve: resolver(PUBLIC), transport: transport({ 'https://recipes.example.com/r': () => page(NYT) }) })

  it('is for signed-in accounts only', async () => {
    const calls: Calls = []
    const handler = recipeImportHandler({ resolve: resolver(PUBLIC), transport: transport({}, calls) })
    expect((await post(handler, { url: 'https://recipes.example.com/r' })).status).toBe(401)
    expect((await post(handler, { url: 'https://recipes.example.com/r' }, 'forged')).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('answers a signed-in account with the recipe', async () => {
    const res = await post(fake(), { url: 'https://recipes.example.com/r' }, 'good-u1')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sourceUrl: 'https://recipes.example.com/r', recipe: { name: 'Coconut Chicken Curry', servings: 4 } })
  })

  it('turns a refused link into a status and a sentence', async () => {
    expect((await post(fake(), { url: 'file:///etc/passwd' }, 'good-u2')).status).toBe(400)
    expect((await post(fake(), {}, 'good-u2')).status).toBe(400)
    const inside = await post(fake(), { url: 'http://169.254.169.254/latest/meta-data/' }, 'good-u2')
    expect(inside.status).toBe(403)
    expect((await inside.json()).error).toMatch(/isn’t a public web page/)
  })

  it('takes POST only', async () => {
    expect((await fake()(new Request('https://site.test/api/recipe-import?url=x'))).status).toBe(405)
  })

  it('stops an account after its imports for the ten minutes, and only that account', async () => {
    const handler = fake(2)
    expect((await post(handler, { url: 'https://recipes.example.com/r' }, 'good-busy')).status).toBe(200)
    expect((await post(handler, { url: 'https://recipes.example.com/r' }, 'good-busy')).status).toBe(200)
    const refused = await post(handler, { url: 'https://recipes.example.com/r' }, 'good-busy')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await post(handler, { url: 'https://recipes.example.com/r' }, 'good-quiet')).status).toBe(200)
  })

  it('is the function Netlify serves, with the app shell’s CORS', async () => {
    const fn = recipeImportFunction as (req: Request) => Promise<Response>
    const preflight = await fn(new Request('https://site.test/api/recipe-import', { method: 'OPTIONS', headers: { origin: 'capacitor://drafter' } }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('capacitor://drafter')
    const refused = await post(fn, { url: 'http://127.0.0.1/' }, 'good-u3', { origin: 'capacitor://drafter' })
    expect(refused.status).toBe(403)
    expect(refused.headers.get('access-control-allow-origin')).toBe('capacitor://drafter')
  })
})
