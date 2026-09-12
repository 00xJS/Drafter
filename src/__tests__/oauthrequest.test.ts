import { describe, expect, it } from 'vitest'
import { OAUTH_REQUEST_KEY, OAUTH_REQUEST_MAX_AGE_MS, captureAuthorizeRequest, clearAuthorizeRequest, pendingAuthorizeRequest, returnsTo, safeRedirect } from '../oauthRequest'
import { claudeCodeCommand, connectionKindLabel, desktopConfig, withRead } from '../agents'

// The app's half of connecting an assistant: keeping /oauth/authorize's query
// safe from the planner's link handling, and the strings Settings → Assistants
// hands the user to paste.

class MemoryStore {
  items = new Map<string, string>()
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
}

class Refusing extends MemoryStore {
  setItem() {
    throw new Error('QuotaExceededError')
  }
  getItem(): string | null {
    throw new Error('SecurityError')
  }
}

function history() {
  const replaced: (string | URL | null | undefined)[] = []
  return { replaced, replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => void replaced.push(url) }
}

const QUERY = '?response_type=code&client_id=dcr_abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=x&code_challenge_method=S256&state=s'

describe('captureAuthorizeRequest', () => {
  it('keeps the query of /oauth/authorize and puts the address bar back to /', () => {
    const store = new MemoryStore()
    const h = history()
    expect(captureAuthorizeRequest({ pathname: '/oauth/authorize', search: QUERY }, h, store, 1000)).toBe(true)
    expect(h.replaced).toEqual(['/'])
    expect(JSON.parse(store.getItem(OAUTH_REQUEST_KEY)!)).toEqual({ search: QUERY, at: 1000 })
    expect(pendingAuthorizeRequest(store, 2000)?.get('client_id')).toBe('dcr_abc')
  })

  it('leaves every other path alone', () => {
    const store = new MemoryStore()
    const h = history()
    for (const pathname of ['/', '/oauth/token', '/oauth/authorized', '/api/oauth/request']) {
      expect(captureAuthorizeRequest({ pathname, search: QUERY }, h, store)).toBe(false)
    }
    expect(h.replaced).toEqual([])
    expect(store.items.size).toBe(0)
  })

  it('an empty query keeps nothing, and still leaves the page', () => {
    const store = new MemoryStore()
    const h = history()
    expect(captureAuthorizeRequest({ pathname: '/oauth/authorize/', search: '' }, h, store)).toBe(false)
    expect(h.replaced).toEqual(['/'])
    expect(store.items.size).toBe(0)
  })

  it('survives storage that refuses', () => {
    const h = history()
    expect(captureAuthorizeRequest({ pathname: '/oauth/authorize', search: QUERY }, h, new Refusing())).toBe(false)
    expect(h.replaced).toEqual(['/'])
    expect(pendingAuthorizeRequest(new Refusing())).toBeNull()
    expect(pendingAuthorizeRequest(null)).toBeNull()
  })
})

describe('pendingAuthorizeRequest', () => {
  it('forgets a request older than ten minutes, or one it cannot read', () => {
    const store = new MemoryStore()
    captureAuthorizeRequest({ pathname: '/oauth/authorize', search: QUERY }, history(), store, 0)
    expect(pendingAuthorizeRequest(store, OAUTH_REQUEST_MAX_AGE_MS - 1)).not.toBeNull()
    expect(pendingAuthorizeRequest(store, OAUTH_REQUEST_MAX_AGE_MS)).toBeNull()
    expect(store.items.size).toBe(0)
    store.setItem(OAUTH_REQUEST_KEY, 'not json')
    expect(pendingAuthorizeRequest(store)).toBeNull()
    expect(store.items.size).toBe(0)
  })

  it('clearAuthorizeRequest drops it', () => {
    const store = new MemoryStore()
    captureAuthorizeRequest({ pathname: '/oauth/authorize', search: QUERY }, history(), store)
    clearAuthorizeRequest(store)
    expect(pendingAuthorizeRequest(store)).toBeNull()
  })
})

describe('where the answer goes', () => {
  it('leaves only for https, or http on this computer', () => {
    expect(safeRedirect('https://claude.ai/api/mcp/auth_callback?code=x&state=s&iss=y')).toBe(true)
    expect(safeRedirect('http://127.0.0.1:33418/callback?code=x')).toBe(true)
    expect(safeRedirect('http://localhost:9/cb')).toBe(true)
    expect(safeRedirect('http://claude.ai/cb')).toBe(false)
    expect(safeRedirect('javascript:alert(1)')).toBe(false)
    expect(safeRedirect('not a url')).toBe(false)
  })

  it('names a loopback redirect as an app on this computer', () => {
    expect(returnsTo({ redirectHost: 'claude.ai', loopback: false })).toBe('claude.ai')
    expect(returnsTo({ redirectHost: '127.0.0.1', loopback: true })).toBe('an app on this computer')
  })
})

describe('what Settings → Assistants hands over', () => {
  const token = `drft_${'k'.repeat(43)}`

  it('the Claude Code one-liner, with the token as a header', () => {
    expect(claudeCodeCommand(token, 'https://drafterz.netlify.app/api/mcp')).toBe(
      `claude mcp add --transport http drafter https://drafterz.netlify.app/api/mcp --header "Authorization: Bearer ${token}"`,
    )
  })

  it('the Claude Desktop entry for the local stdio server', () => {
    expect(JSON.parse(desktopConfig(token, '/Users/me/Drafter/mcp/server.mjs'))).toEqual({
      mcpServers: { drafter: { command: 'node', args: ['/Users/me/Drafter/mcp/server.mjs'], env: { DRAFTER_AGENT_TOKEN: token } } },
    })
  })

  it('scopes always include read, in order', () => {
    expect(withRead(['journal', 'write'])).toEqual(['read', 'write', 'journal'])
    expect(withRead([])).toEqual(['read'])
  })

  it('labels a connection by how it was made', () => {
    expect(connectionKindLabel({ kind: 'token', redirectHost: null })).toBe('Token')
    expect(connectionKindLabel({ kind: 'oauth', redirectHost: 'claude.ai' })).toBe('Claude app')
    expect(connectionKindLabel({ kind: 'oauth', redirectHost: 'claude.com' })).toBe('Claude app')
    expect(connectionKindLabel({ kind: 'oauth', redirectHost: '127.0.0.1' })).toBe('App on this computer')
  })
})
