import { describe, expect, it, vi } from 'vitest'
import type { ReadRecipe } from '../ai'
import { ImportLinkError, NEEDS_SERVER, importRecipeLink } from '../recipeimport'

// The app's half of Import from a link: one POST to /api/recipe-import, the
// page's recipe as the editor takes it, or the page's text read with ✨ as a
// paste is. A copy of the app with no server says so rather than failing in a
// way nobody can act on.

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response
const html = (status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse('<!doctype html>') }) as unknown as Response

const read = vi.fn(async (_text: string): Promise<ReadRecipe> => ({ name: '', servings: 4, ingredients: [{ name: 'beef', qty: 1, unit: 'lb' }], steps: ['Brown it'] }))

async function refused(p: Promise<unknown>): Promise<ImportLinkError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ImportLinkError)
    return e as ImportLinkError
  }
  throw new Error('expected the import to fail')
}

describe('importRecipeLink', () => {
  it('posts the link and takes the page’s recipe as the editor does, with where it came from', async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        sourceUrl: 'https://cooking.example.com/recipes/1-chili',
        recipe: { name: 'Chili', servings: 6, ingredients: [{ name: 'beans', qty: 2, unit: 'can' }, { name: '' }, { name: 'onion', qty: -3 }], steps: ['Simmer', ''] },
      }),
    )
    const got = await importRecipeLink('  https://cooking.example.com/recipes/1-chili  ', { fetch, read, local: false })
    expect(got).toEqual({
      name: 'Chili',
      servings: 6,
      ingredients: [{ name: 'beans', qty: 2, unit: 'can' }, { name: 'onion' }],
      steps: ['Simmer'],
      sourceUrl: 'https://cooking.example.com/recipes/1-chili',
      via: 'page',
    })
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/recipe-import')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://cooking.example.com/recipes/1-chili' })
    expect(read).not.toHaveBeenCalled()
  })

  it('reads a page with no recipe data with ✨, named by the page when the text does not say', async () => {
    const fetch = vi.fn(async () => json(200, { text: 'Grandma’s meatballs\n1 lb beef\nBrown it', title: 'Grandma’s Meatballs', sourceUrl: 'https://blog.example.com/meatballs' }))
    const got = await importRecipeLink('https://blog.example.com/meatballs', { fetch, read, local: false })
    expect(read).toHaveBeenCalledWith('Grandma’s meatballs\n1 lb beef\nBrown it')
    expect(got).toMatchObject({ name: 'Grandma’s Meatballs', via: 'text', sourceUrl: 'https://blog.example.com/meatballs', ingredients: [{ name: 'beef', qty: 1, unit: 'lb' }] })
  })

  it('keeps only a web address as the source', async () => {
    const fetch = vi.fn(async () => json(200, { sourceUrl: 'javascript:alert(1)', recipe: { name: 'X', ingredients: [{ name: 'y' }], steps: [] } }))
    expect((await importRecipeLink('https://example.com/x', { fetch, read, local: false })).sourceUrl).toBe('https://example.com/x')
  })

  it('refuses what is not a link, without asking the server', async () => {
    const fetch = vi.fn()
    for (const bad of ['', 'chicken curry', 'ftp://example.com/r', 'javascript:alert(1)']) {
      const err = await refused(importRecipeLink(bad, { fetch, read, local: false }))
      expect(err.noServer).toBe(false)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says it needs Drafter’s server when there is none to ask', async () => {
    const cases = [
      vi.fn(async () => {
        throw new Error('The server is unreachable from here')
      }),
      vi.fn(async () => html(404)),
      vi.fn(async () => html(200)),
      vi.fn(async () => json(404, { error: 'not found' })),
    ]
    for (const fetch of cases) {
      const err = await refused(importRecipeLink('https://example.com/r', { fetch, read, local: false }))
      expect(err.message).toBe(NEEDS_SERVER)
      expect(err.noServer).toBe(true)
    }
    // a copy with no accounts: the server has nobody to sign in
    for (const status of [401, 503]) {
      const err = await refused(importRecipeLink('https://example.com/r', { fetch: vi.fn(async () => json(status, { error: 'sign in required' })), read, local: true }))
      expect(err.message).toBe(NEEDS_SERVER)
    }
  })

  it('passes on what the server says about a page that would not import', async () => {
    const err = await refused(importRecipeLink('https://example.com/r', { fetch: vi.fn(async () => json(403, { error: 'Drafter won’t open that address: it isn’t a public web page.' })), read, local: false }))
    expect(err.message).toMatch(/isn’t a public web page/)
    expect(err.noServer).toBe(false)
    const expired = await refused(importRecipeLink('https://example.com/r', { fetch: vi.fn(async () => json(401, { error: 'invalid session' })), read, local: false }))
    expect(expired.message).toMatch(/sign in again/)
  })

  it('says so when the page has nothing a cook could use', async () => {
    const empty = vi.fn(async () => ({ name: '', ingredients: [], steps: [] }))
    const err = await refused(importRecipeLink('https://example.com/r', { fetch: vi.fn(async () => json(200, { text: 'About us', title: 'About', sourceUrl: 'https://example.com/r' })), read: empty, local: false }))
    expect(err.message).toMatch(/Nothing on that page reads like a recipe/)
  })
})
