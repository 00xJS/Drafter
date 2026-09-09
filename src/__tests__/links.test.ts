import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { oauthReasonLabel, paramsOf, parseLink, safeHttpUrl } from '../links'

describe('parseLink', () => {
  it('parses OAuth success and maps known failure reasons', () => {
    expect(parseLink(new URLSearchParams('google=connected')).oauth).toEqual({
      provider: 'google',
      ok: true,
      reason: undefined,
    })
    expect(parseLink(new URLSearchParams('microsoft=error&reason=bad_state')).oauth).toMatchObject({
      provider: 'microsoft',
      ok: false,
      reason: 'bad state',
    })
    expect(oauthReasonLabel('<script>alert(1)</script>')).toBe('unknown error')
  })

  it('scopes drafter://oauth host to OAuth only', () => {
    const p = parseLink(new URLSearchParams('title=Nope&google=connected'), { host: 'oauth' })
    expect(p.oauth?.ok).toBe(true)
    expect(p.capture).toBeUndefined()
  })

  it('ignores unknown drafter:// hosts', () => {
    expect(parseLink(new URLSearchParams('title=Hack'), { host: 'evil' })).toEqual({})
  })

  it('moves a bare URL title into link and rejects javascript:', () => {
    const cap = parseLink(new URLSearchParams('title=https://example.com/x')).capture
    expect(cap?.title).toBe('')
    expect(cap?.link).toBe('https://example.com/x')
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined()
    expect(parseLink(new URLSearchParams('url=javascript:alert(1)&title=Hi')).capture?.link).toBeUndefined()
  })

  it('parses saw / task / view together with capture fields', () => {
    const p = parseLink(new URLSearchParams('view=today&saw=p1&due=2026-09-10T15:00:00.000Z&title=Dentist'))
    expect(p.view).toBe('today')
    expect(p.saw).toBe('p1')
    expect(p.capture?.title).toBe('Dentist')
    expect(p.capture?.dueAt).toBe('2026-09-10T15:00:00.000Z')
  })

  it('parses ?place= from a "Been a while" reminder and never carries an action', () => {
    const { host, params } = paramsOf('/?place=pl1')
    const p = parseLink(params, { host, allowAct: true })
    expect(p.place).toBe('pl1')
    expect(p.capture).toBeUndefined()
    // a place banner has no buttons, so a stray act= beside it must stay unread
    expect(parseLink(new URLSearchParams('place=pl1&act=done'), { allowAct: true }).act).toBeUndefined()
    expect(parseLink(new URLSearchParams('place=pl1'), { host: 'evil' }).place).toBeUndefined()
  })

  it('paramsOf extracts host from drafter:// URLs', () => {
    expect(paramsOf('drafter://oauth?google=connected').host).toBe('oauth')
    expect(paramsOf('drafter://new?title=Hi').params.get('title')).toBe('Hi')
  })

  it('paramsOf treats the app\u2019s own origin as no host, so a notification tap still routes', () => {
    // under the iOS shell the page origin is capacitor://localhost, so a reminder's
    // `/?task=\u2026` resolved to the host "localhost" and was dropped as unknown
    const { host, params } = paramsOf('/?task=t1')
    expect(host).toBe('')
    expect(parseLink(params, { host }).task).toBe('t1')
    expect(paramsOf('https://drafter.local/?saw=p1').host).toBe('')
  })

  it('keeps scoping a real drafter:// host', () => {
    expect(paramsOf('drafter://journal?text=Hi').host).toBe('journal')
    expect(parseLink(new URLSearchParams('task=t1'), { host: 'evil' }).task).toBeUndefined()
  })

  it('reads an action button only next to the id it acts on', () => {
    const act = { allowAct: true }
    expect(parseLink(new URLSearchParams('task=t1&act=done'), act).act).toBe('done')
    expect(parseLink(new URLSearchParams('task=t1&act=tomorrow'), act).act).toBe('tomorrow')
    expect(parseLink(new URLSearchParams('saw=p1&act=saw'), act).act).toBe('saw')
    // an unknown action, and a bare act= with nothing to act on, are both ignored
    expect(parseLink(new URLSearchParams('task=t1&act=delete'), act).act).toBeUndefined()
    expect(parseLink(new URLSearchParams('act=done'), act).act).toBeUndefined()
    expect(parseLink(new URLSearchParams('title=Hi&act=done'), act).act).toBeUndefined()
  })

  it('opens an empty capture for a bare drafter://new', () => {
    // the Home Screen quick action carries no params at all
    const { host, params } = paramsOf('drafter://new')
    const cap = parseLink(params, { host }).capture
    expect(cap).toBeDefined()
    expect(cap?.title).toBe('')
    expect(cap?.link).toBeUndefined()
    expect(cap?.description).toBeUndefined()
    // …and it stays scoped to the scheme: the share target and the web query
    // string arrive with no host, where an empty link still means nothing
    expect(parseLink(new URLSearchParams(''), { host: '' }).capture).toBeUndefined()
    expect(parseLink(new URLSearchParams(''), { host: 'open' }).capture).toBeUndefined()
    expect(parseLink(new URLSearchParams('title=Hi'), { host: 'evil' }).capture).toBeUndefined()
  })

  it('ignores an action button unless the caller opted in', () => {
    // only the notification handler passes allowAct, so a crafted web link —
    // https://…/?task=t1&act=done — cannot complete a task from the query string
    expect(parseLink(new URLSearchParams('task=t1&act=done')).act).toBeUndefined()
    expect(parseLink(new URLSearchParams('saw=p1&act=saw'), { host: 'new' }).act).toBeUndefined()
    expect(parseLink(new URLSearchParams('task=t1&act=done'), { allowAct: false }).act).toBeUndefined()
    // the id itself still routes as before
    expect(parseLink(new URLSearchParams('task=t1&act=done')).task).toBe('t1')
  })
})

/**
 * The Home Screen quick actions are a plist promise: iOS shows whatever
 * Info.plist advertises, and SceneDelegate is the only thing that turns a tapped
 * type back into a route. A menu item that launches the app and does nothing is
 * worse than no menu item, so the two lists — and the routes themselves — are
 * checked here rather than on the device.
 */
describe('Home Screen quick actions', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  const plist = read('../../ios/App/App/Info.plist')
  const swift = read('../../ios/App/App/SceneDelegate.swift')

  /** Every `UIApplicationShortcutItem…` dict in Info.plist. */
  const items = [...plist.matchAll(/<dict>([\s\S]*?)<\/dict>/g)]
    .map(m => m[1])
    .filter(body => body.includes('UIApplicationShortcutItemType'))
    .map(body => ({
      type: /<key>UIApplicationShortcutItemType<\/key>\s*<string>([^<]*)<\/string>/.exec(body)?.[1] ?? '',
      title: /<key>UIApplicationShortcutItemTitle<\/key>\s*<string>([^<]*)<\/string>/.exec(body)?.[1] ?? '',
    }))

  /** The `case "<type>": … URL(string: "drafter://…")` mapper in SceneDelegate. */
  const routes = new Map(
    // the class is what iOS allows in a shortcut item type, not just [a-z]: a
    // fourth item typed `new-task` must still be seen, or this fails on code
    // that is right. Anchored to the case's own `return` (only its comments may
    // come between) so a case that returns nil cannot borrow the next one's URL
    // and pass as mapped.
    [...swift.matchAll(/case "([A-Za-z0-9._-]+)":\s*(?:\/\/[^\n]*\n\s*)*return URL\(string: "(drafter:\/\/[^"]+)"\)/g)].map(
      m => [m[1], m[2]] as const,
    ),
  )

  it('advertises three items, each with the Title iOS requires', () => {
    expect(items.map(i => i.type)).toEqual(['journal', 'new', 'today'])
    for (const i of items) expect(i.title).not.toBe('')
  })

  it('maps every advertised type to a drafter:// route', () => {
    expect([...routes.keys()].sort()).toEqual(items.map(i => i.type).sort())
  })

  it('routes each one somewhere the app actually goes', () => {
    const parse = (raw: string) => {
      const { host, params } = paramsOf(raw)
      return parseLink(params, { host })
    }
    // today's journal editor — not drafter://journal, which carries a line to append
    expect(parse(routes.get('journal')!).tab).toBe('journal')
    expect(parse(routes.get('journal')!).journal).toBeUndefined()
    // an empty capture sheet
    expect(parse(routes.get('new')!).capture).toEqual({ title: '', description: undefined, link: undefined })
    // and the Today view
    expect(parse(routes.get('today')!).view).toBe('today')
  })
})
