import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantsSection } from '../components/AssistantsSection'
import type { AssistantsApi } from '../components/AssistantsSection'
import { ConnectAssistantSheet } from '../components/ConnectAssistantSheet'
import type { AgentsInfo } from '../agents'

// The two standalone pieces a later stream wires into Settings and App: their
// first render, before any effect, with no network.

const never = () => new Promise<never>(() => {})
const offline: AssistantsApi = { list: never, create: never, revoke: never }

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
    expect(html).toContain('drft_AbCd…')
    expect(html).toContain('Revoke')
  })

  it('says so when the site is not set up, and loads without a seed', () => {
    const notSetUp = <AssistantsSection api={offline} initial={{ configured: false, connections: [] }} connectorUrl="https://x.test/api/mcp" />
    expect(renderToStaticMarkup(notSetUp)).toContain('aren’t set up on this site yet')
    // node has no window, so the connector URL is given rather than read from the location
    expect(renderToStaticMarkup(<AssistantsSection api={offline} className="settings-section" connectorUrl="https://x.test/api/mcp" />)).toContain('Loading connections…')
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
