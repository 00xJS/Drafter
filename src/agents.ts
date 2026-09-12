// Settings → Assistants: the connections Claude (on the web and the phone),
// Claude Code or a local MCP server hold on this account. The server side is
// netlify/functions/agents.mjs; a manual token's secret is in the create
// response once and nowhere else — this module never stores it.

import { ApiError, apiFetch, siteOrigin } from './api'

export type AgentScope = 'read' | 'write' | 'journal'

export interface AgentConnection {
  id: string
  kind: 'token' | 'oauth'
  name: string
  redirectHost: string | null
  scopes: AgentScope[]
  tokenPrefix: string | null
  createdAt: string
  lastUsedAt: string | null
}

export interface AgentsInfo {
  configured: boolean
  connections: AgentConnection[]
}

export interface CreatedToken {
  token: string
  connection: AgentConnection
}

const ORDER: AgentScope[] = ['read', 'write', 'journal']

/** New connections can add and change things; the journal stays out unless ticked. */
export const DEFAULT_SCOPES: AgentScope[] = ['read', 'write']

export const SCOPE_LABELS: Record<AgentScope, string> = { read: 'Can see', write: 'Can change', journal: 'Journal' }

/** The connector URL for Claude's "Add custom connector" and for Claude Code. */
export function mcpUrl(): string {
  return `${siteOrigin()}/api/mcp`
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Known scopes in order, read always among them. */
export function withRead(scopes: readonly string[]): AgentScope[] {
  const wanted = new Set<string>([...scopes, 'read'])
  return ORDER.filter(s => wanted.has(s))
}

async function call<T>(init?: RequestInit): Promise<T> {
  const res = await apiFetch('/api/agents', init)
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 409 && body?.error === 'limit') throw new ApiError('You already have 20 connections — revoke one first.', 409)
    if (res.status === 501) throw new ApiError('Assistants aren’t set up on this site yet.', 501)
    throw new ApiError(typeof body?.error === 'string' ? body.error : `Assistants are unavailable right now (${res.status}).`, res.status)
  }
  return body as T
}

const post = <T>(body: Record<string, unknown>) => call<T>({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export function agentsList(): Promise<AgentsInfo> {
  return call<AgentsInfo>()
}

/** Create a manual token. The returned secret is shown once; keep it in component state only. */
export function agentsCreate(input: { name: string; scopes: readonly AgentScope[]; timezone?: string }): Promise<CreatedToken> {
  return post<CreatedToken>({ action: 'create', name: input.name, scopes: withRead(input.scopes), timezone: input.timezone ?? deviceTimeZone() })
}

export async function agentsRevoke(id: string): Promise<boolean> {
  return (await post<{ ok: boolean }>({ action: 'revoke', id })).ok
}

export async function agentsRename(id: string, name: string): Promise<boolean> {
  return (await post<{ ok: boolean }>({ action: 'rename', id, name })).ok
}

/** Claude Code, over HTTP with the token as a header. */
export function claudeCodeCommand(token: string, url = mcpUrl()): string {
  return `claude mcp add --transport http drafter ${url} --header "Authorization: Bearer ${token}"`
}

/** Claude Desktop's entry for the local stdio server (mcp/server.mjs in a checkout of Drafter). */
export function desktopConfig(token: string, serverPath = '<path to Drafter>/mcp/server.mjs'): string {
  return JSON.stringify({ mcpServers: { drafter: { command: 'node', args: [serverPath], env: { DRAFTER_AGENT_TOKEN: token } } } }, null, 2)
}

const CLAUDE_HOSTS = new Set(['claude.ai', 'claude.com'])
const LOOPBACK = new Set(['localhost', '127.0.0.1'])

/** The chip on a connection row. */
export function connectionKindLabel(c: Pick<AgentConnection, 'kind' | 'redirectHost'>): string {
  if (c.kind === 'token') return 'Token'
  if (c.redirectHost && CLAUDE_HOSTS.has(c.redirectHost)) return 'Claude app'
  if (c.redirectHost && LOOPBACK.has(c.redirectHost)) return 'App on this computer'
  return 'Connected app'
}
