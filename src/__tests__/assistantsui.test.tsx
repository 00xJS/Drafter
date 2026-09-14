import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantsSection, ConnectionRow } from '../components/AssistantsSection'
import type { AssistantsApi } from '../components/AssistantsSection'
import { ConnectAssistantSheet } from '../components/ConnectAssistantSheet'
import { agentsRename, expiryLine, nameToSave, renameIn } from '../agents'
import type { AgentsInfo } from '../agents'

// The two standalone pieces a later stream wires into Settings and App: their
// first render, before any effect, with no network. The rows are dated, so the
// clock is fixed: a token lapses 180 days after its last use.

const never = () => new Promise<never>(() => {})
const offline: AssistantsApi = { list: never, create: never, revoke: never, rename: never }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const INFO: AgentsInfo = {
  configured: true,
  connections: [
    { id: 'c1', kind: 'oauth', name: 'Claude', redirectHost: 'claude.ai', scopes: ['read', 'write'], tokenPrefix: null, createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: null },
    { id: 'c2', kind: 'token', name: 'Laptop', redirectHost: null, scopes: ['read'], tokenPrefix: 'drft_AbCd', createdAt: '2026-09-02T10:00:00.000Z', lastUsedAt: '2026-09-02T11:00:00.000Z' },
  ],
}

describe('AssistantsSection', () => {
  it('shows the connector URL, the token form with write on and journal off, and each connection', () => {
    const html = renderToStaticMarkup(<AssistantsSection api={offline} initial={INFO} connectorUrl="https://drafterz.netlify.app/api/mcp" />)
    expect(html).toContain('class="settings-section g-assistants"')
    expect(html).toContain('value="https://drafterz.netlify.app/api/mcp"')
    expect(html).toContain('Claude app (web, iPhone, Android)')
    expect(html).toContain('Claude Code and other apps')
    expect(html).toContain('Can add and change things')
    expect(html).toContain('Can read and write my journal')
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1)
    expect(html).toContain('Claude app</span>')
    expect(html).toContain('Token</span>')
    expect(html).toContain('never used')
    expect(html).toContain('last used 12d 1h ago')
    expect(html).toContain('drft_AbCd…')
    // a token says how it lapses; the Claude app's connection renews itself
    expect(html.match(/Expires after 180 days unused/g)).toHaveLength(1)
    expect(html).toContain('A token stops working after 180 days unused.')
    expect(html.match(/>Rename<\/button>/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Rename Laptop"')
    expect(html.match(/>Revoke<\/button>/g)).toHaveLength(2)
  })

  it('says so when the site is not set up, and loads without a seed', () => {
    const notSetUp = <AssistantsSection api={offline} initial={{ configured: false, connections: [] }} connectorUrl="https://x.test/api/mcp" />
    expect(renderToStaticMarkup(notSetUp)).toContain('aren’t set up on this site yet')
    // node has no window, so the connector URL is given rather than read from the location
    expect(renderToStaticMarkup(<AssistantsSection api={offline} className="settings-section" connectorUrl="https://x.test/api/mcp" />)).toContain('Loading connections…')
  })
})

describe('renaming a connection', () => {
  const laptop = INFO.connections[1]

  it('opens a field in place, with Save and Cancel and no Revoke while it is open', () => {
    const html = renderToStaticMarkup(<ConnectionRow connection={laptop} onRename={never} onRevoke={() => {}} startRenaming />)
    expect(html).toContain('value="Laptop"')
    expect(html).toContain('aria-label="New name for Laptop"')
    expect(html).toContain('maxLength="80"')
    expect(html).toContain('>Save</button>')
    expect(html).toContain('>Cancel</button>')
    expect(html).not.toContain('Revoke')
  })

  it('saves only a real change, cleaned the way the server keeps names', () => {
    expect(nameToSave('  Work \n laptop ', 'Laptop')).toBe('Work laptop')
    expect(nameToSave(' Laptop ', 'Laptop')).toBeNull()
    expect(nameToSave('   ', 'Laptop')).toBeNull()
    expect(nameToSave('x'.repeat(100), 'Laptop')).toHaveLength(80)
  })

  it('puts the new name in the list and leaves the other connections as they were', () => {
    const next = renameIn(INFO, 'c2', ' Work  laptop ')
    expect(next.connections.map(c => c.name)).toEqual(['Claude', 'Work laptop'])
    expect(next.connections[0]).toBe(INFO.connections[0])
    expect(renameIn(INFO, 'gone', 'x').connections.map(c => c.name)).toEqual(['Claude', 'Laptop'])
  })

  it('asks /api/agents to rename that connection by id', async () => {
    const sent: { url: string; body: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return Response.json({ ok: true })
      }),
    )
    expect(await agentsRename('c2', 'Work laptop')).toBe(true)
    expect(sent).toEqual([{ url: '/api/agents', body: { action: 'rename', id: 'c2', name: 'Work laptop' } }])
  })
})

describe('a token says when it lapses', () => {
  const token = { kind: 'token' as const, createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: '2026-09-10T10:00:00.000Z' }

  it('"Expires after 180 days unused" while that is more than a month away', () => {
    expect(expiryLine(token, new Date('2026-09-14T12:00:00.000Z'))).toBe('Expires after 180 days unused')
  })

  it('and the day once it is under a month away, counted from its last use, or from when it was made if never used', () => {
    const feb = new Date('2027-02-01T12:00:00.000Z')
    // last used 10 September: lapses 9 March, 36 days on
    expect(expiryLine(token, feb)).toBe('Expires after 180 days unused')
    // never used, made 1 September: lapses 28 February, 27 days on
    expect(expiryLine({ ...token, lastUsedAt: null }, feb)).toMatch(/^Expires after 180 days unused: on .+ unless it is used$/)
  })

  it('says nothing for the Claude app, whose connection renews itself as it is used', () => {
    expect(expiryLine({ ...token, kind: 'oauth' })).toBe('')
  })
})

describe('ConnectAssistantSheet', () => {
  it('checks the request before offering anything, and navigates nowhere on its own', () => {
    const went: string[] = []
    const html = renderToStaticMarkup(
      <ConnectAssistantSheet
        params={new URLSearchParams('client_id=dcr_x')}
        email="owner@example.test"
        onDone={() => {}}
        onSignOut={() => {}}
        describe={never}
        approve={never}
        navigate={url => went.push(url)}
      />,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Checking the request…')
    expect(html).not.toContain('Allow')
    expect(went).toEqual([])
  })
})
