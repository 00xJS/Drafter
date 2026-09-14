import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  currentTheme,
  parseThemePref,
  readThemePref,
  resolveTheme,
  setThemePref,
  startTheme,
  subscribeTheme,
  THEME_GROUND,
  THEME_KEY,
  THEME_LABELS,
  THEME_PREFS,
  type Theme,
  type ThemePref,
} from '../theme'

/*
 * Settings → Appearance is one attribute on <html>, painted twice: by the
 * inline script in index.html before the first paint, and by src/theme.ts
 * from then on. vitest runs in node, so the document, the window and storage
 * are small stand-ins, and the inline script is run as it is written.
 */

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')

/** localStorage over a Map. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  }
}

/** Storage that refuses everything, like Safari's with site data blocked. */
const refusingStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => {
    throw new Error('SecurityError')
  },
}

/** What the theme touches of a document: <html>'s attribute and inline style, and the theme-color meta. */
function stubDocument() {
  const attrs = new Map<string, string>()
  const meta = {
    content: THEME_GROUND.light,
    setAttribute(name: string, value: string) {
      if (name === 'content') meta.content = value
    },
  }
  const documentElement = {
    style: { colorScheme: '' },
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    getAttribute: (name: string) => attrs.get(name) ?? null,
  }
  return {
    documentElement,
    querySelector: (sel: string) => (sel === 'meta[name="theme-color"]' ? meta : null),
    painted: () => ({ theme: attrs.get('data-theme'), colorScheme: documentElement.style.colorScheme, meta: meta.content }),
  }
}

/** A window whose prefers-color-scheme can be flipped, and whose listeners can be counted. */
function stubWindow(dark = false) {
  const state = { dark }
  const media = new Set<() => void>()
  const storage = new Set<(e: { key: string | null }) => void>()
  const query = {
    get matches() {
      return state.dark
    },
    addEventListener: (_: string, cb: () => void) => void media.add(cb),
    removeEventListener: (_: string, cb: () => void) => void media.delete(cb),
  }
  const win = {
    matchMedia: (q: string) => {
      expect(q).toBe('(prefers-color-scheme: dark)')
      return query
    },
    addEventListener: (type: string, cb: (e: { key: string | null }) => void) => {
      if (type === 'storage') storage.add(cb)
    },
    removeEventListener: (type: string, cb: (e: { key: string | null }) => void) => {
      if (type === 'storage') storage.delete(cb)
    },
  }
  return {
    win,
    setSystemDark(on: boolean) {
      state.dark = on
      for (const cb of [...media]) cb()
    },
    otherTabWrote(key: string | null) {
      for (const cb of [...storage]) cb({ key })
    },
    listening: () => ({ media: media.size, storage: storage.size }),
  }
}

/** Stand in for the page: `stored` fills a Map-backed storage (returned as `storage`), or `refuse` swaps in one that throws. */
function stubPage(opts: { stored?: Record<string, string>; refuse?: boolean; dark?: boolean } = {}) {
  const doc = stubDocument()
  const w = stubWindow(opts.dark)
  const storage = memoryStorage(opts.stored)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', w.win)
  vi.stubGlobal('localStorage', opts.refuse ? refusingStorage : storage)
  return { doc, ...w, storage }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a stored choice', () => {
  it('is light unless it says dark or system', () => {
    expect(parseThemePref('dark')).toBe('dark')
    expect(parseThemePref('system')).toBe('system')
    expect(parseThemePref('light')).toBe('light')
    for (const junk of [null, undefined, '', 'Dark', 'auto', 'garbage', 1, 0, true, {}]) expect(parseThemePref(junk), String(junk)).toBe('light')
  })

  it('lives under drafter:theme and is offered as Light, Dark, Match system', () => {
    expect(THEME_KEY).toBe('drafter:theme')
    expect(THEME_PREFS).toEqual(['light', 'dark', 'system'])
    expect(THEME_PREFS.map(p => THEME_LABELS[p])).toEqual(['Light', 'Dark', 'Match system'])
  })
})

describe('resolving a choice to a theme', () => {
  it('follows the table: only Dark, or Match system on a dark device, is dark', () => {
    const table: [ThemePref, boolean, Theme][] = [
      ['light', false, 'light'],
      ['light', true, 'light'],
      ['dark', false, 'dark'],
      ['dark', true, 'dark'],
      ['system', false, 'light'],
      ['system', true, 'dark'],
    ]
    for (const [pref, systemDark, theme] of table) expect(resolveTheme(pref, systemDark), `${pref} / system dark ${systemDark}`).toBe(theme)
  })
})

describe('reading this device’s choice', () => {
  it('is light when nothing is stored', () => {
    stubPage()
    expect(readThemePref()).toBe('light')
  })

  it('reads what was stored, and treats anything unknown as light', () => {
    stubPage({ stored: { [THEME_KEY]: 'system' } })
    expect(readThemePref()).toBe('system')
    stubPage({ stored: { [THEME_KEY]: 'sepia' } })
    expect(readThemePref()).toBe('light')
  })

  it('is light when storage cannot be read at all', () => {
    stubPage({ refuse: true })
    expect(readThemePref()).toBe('light')
  })

  it('is light in node, where there is no usable storage', () => {
    expect(readThemePref()).toBe('light')
  })
})

describe('painting a theme', () => {
  it('sets data-theme, the inline color-scheme and the theme-color meta together', () => {
    const doc = stubDocument()
    applyTheme('dark', doc as unknown as Document)
    expect(doc.painted()).toEqual({ theme: 'dark', colorScheme: 'dark', meta: THEME_GROUND.dark })
    applyTheme('light', doc as unknown as Document)
    expect(doc.painted()).toEqual({ theme: 'light', colorScheme: 'light', meta: THEME_GROUND.light })
    // idempotent
    applyTheme('light', doc as unknown as Document)
    expect(doc.painted()).toEqual({ theme: 'light', colorScheme: 'light', meta: THEME_GROUND.light })
  })

  it('reads light off a page with no attribute, and does nothing without a document', () => {
    expect(currentTheme()).toBe('light')
    expect(() => applyTheme('dark')).not.toThrow()
  })
})

describe('choosing in Settings → Appearance', () => {
  it('stores the choice explicitly, light included, and repaints at once', () => {
    const page = stubPage({ stored: { [THEME_KEY]: 'dark' } })
    const heard = vi.fn()
    const stop = subscribeTheme(heard)
    setThemePref('light')
    expect(page.storage.data.get(THEME_KEY)).toBe('light')
    expect(page.doc.painted()).toEqual({ theme: 'light', colorScheme: 'light', meta: THEME_GROUND.light })
    setThemePref('dark')
    expect(page.storage.data.get(THEME_KEY)).toBe('dark')
    expect(page.doc.painted()).toEqual({ theme: 'dark', colorScheme: 'dark', meta: THEME_GROUND.dark })
    expect(currentTheme()).toBe('dark')
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    setThemePref('system')
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('still repaints when storage refuses to keep the choice', () => {
    const page = stubPage({ refuse: true })
    expect(() => setThemePref('dark')).not.toThrow()
    expect(page.doc.painted().theme).toBe('dark')
  })
})

describe('startTheme: the session after the first paint', () => {
  it('paints the stored choice and tells the shell once', () => {
    const page = stubPage({ stored: { [THEME_KEY]: 'dark' } })
    const onChange = vi.fn()
    const stop = startTheme(onChange)
    expect(page.doc.painted()).toEqual({ theme: 'dark', colorScheme: 'dark', meta: THEME_GROUND.dark })
    expect(onChange.mock.calls).toEqual([['dark', 'dark']])
    stop()
  })

  it('paints light when nothing is stored, even on a dark device', () => {
    const page = stubPage({ dark: true })
    const stop = startTheme()
    expect(page.doc.painted()).toEqual({ theme: 'light', colorScheme: 'light', meta: THEME_GROUND.light })
    stop()
  })

  it('follows the device live under Match system, and the shell hears each change', () => {
    const page = stubPage({ stored: { [THEME_KEY]: 'system' } })
    const onChange = vi.fn()
    const stop = startTheme(onChange)
    expect(page.doc.painted().theme).toBe('light')
    page.setSystemDark(true)
    expect(page.doc.painted()).toEqual({ theme: 'dark', colorScheme: 'dark', meta: THEME_GROUND.dark })
    page.setSystemDark(false)
    expect(page.doc.painted().theme).toBe('light')
    expect(onChange.mock.calls).toEqual([
      ['system', 'light'],
      ['system', 'dark'],
      ['system', 'light'],
    ])
    stop()
  })

  it('ignores the device under Light or Dark, but keeps listening for a later Match system', () => {
    const page = stubPage({ stored: { [THEME_KEY]: 'light' } })
    const onChange = vi.fn()
    const stop = startTheme(onChange)
    page.setSystemDark(true)
    expect(page.doc.painted().theme).toBe('light')
    setThemePref('dark')
    page.setSystemDark(false)
    expect(page.doc.painted().theme).toBe('dark')
    setThemePref('system')
    expect(page.doc.painted().theme).toBe('light')
    page.setSystemDark(true)
    expect(page.doc.painted().theme).toBe('dark')
    // the shell hears the choice as well as the theme: Dark → Match system on a
    // dark device keeps the page dark but must still let go of the override
    expect(onChange.mock.calls).toEqual([
      ['light', 'light'],
      ['dark', 'dark'],
      ['system', 'light'],
      ['system', 'dark'],
    ])
    stop()
  })

  it('takes a choice made in another tab, and a cleared storage as light', () => {
    const page = stubPage({ stored: { [THEME_KEY]: 'light' } })
    const stop = startTheme()
    page.storage.data.set(THEME_KEY, 'dark')
    page.otherTabWrote('drafter:tasks-tab')
    expect(page.doc.painted().theme).toBe('light')
    page.otherTabWrote(THEME_KEY)
    expect(page.doc.painted().theme).toBe('dark')
    page.storage.data.clear()
    page.otherTabWrote(null)
    expect(page.doc.painted().theme).toBe('light')
    stop()
  })

  it('lets go of every listener when stopped', () => {
    const page = stubPage()
    const onChange = vi.fn()
    const stop = startTheme(onChange)
    expect(page.listening()).toEqual({ media: 1, storage: 1 })
    stop()
    expect(page.listening()).toEqual({ media: 0, storage: 0 })
    setThemePref('dark')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('index.html: the theme before the first paint', () => {
  const head = html.slice(0, html.indexOf('</head>'))
  const script = /<script>([\s\S]*?)<\/script>/.exec(head)?.[1] ?? ''

  /** Run the inline script as the browser would, against stand-ins, and read back what it painted. */
  function prePaint(stored: string | undefined | 'refuse', systemDark: boolean, matchMedia = true) {
    const doc = stubDocument()
    const { win } = stubWindow(systemDark)
    const storage = stored === 'refuse' ? refusingStorage : memoryStorage(stored === undefined ? {} : { [THEME_KEY]: stored })
    new Function('window', 'document', 'localStorage', script)(matchMedia ? win : {}, doc, storage)
    return doc.painted()
  }

  it('is an inline classic script in <head>, right after the theme-color meta and before any stylesheet or module', () => {
    expect(script).not.toBe('')
    const at = head.indexOf('<script>')
    expect(at).toBeGreaterThan(head.indexOf('<meta name="theme-color"'))
    expect(head.slice(0, at)).not.toMatch(/<link[^>]*stylesheet|type="module"/)
  })

  it('reads the key theme.ts owns, and the meta starts on the light ground', () => {
    expect(script).toContain(`'${THEME_KEY}'`)
    expect(/<meta name="theme-color" content="(#[0-9a-f]{6})"/.exec(head)?.[1]).toBe(THEME_GROUND.light)
    for (const ground of Object.values(THEME_GROUND)) expect(script).toContain(`'${ground}'`)
  })

  it('picks light when nothing is stored, on a light or a dark device', () => {
    for (const systemDark of [false, true]) {
      expect(prePaint(undefined, systemDark)).toEqual({ theme: 'light', colorScheme: 'light', meta: THEME_GROUND.light })
    }
  })

  it('paints what theme.ts would, for every stored value, device and storage', () => {
    for (const stored of [undefined, '', 'garbage', 'light', 'dark', 'system', 'refuse'] as const) {
      for (const systemDark of [false, true]) {
        const pref = stored === 'refuse' ? 'light' : parseThemePref(stored ?? null)
        const theme = resolveTheme(pref, systemDark)
        expect(prePaint(stored, systemDark), `${stored} / system dark ${systemDark}`).toEqual({ theme, colorScheme: theme, meta: THEME_GROUND[theme] })
      }
    }
  })

  it('treats a browser with no matchMedia as a light device', () => {
    expect(prePaint('system', true, false).theme).toBe('light')
    expect(prePaint('dark', false, false).theme).toBe('dark')
  })
})
