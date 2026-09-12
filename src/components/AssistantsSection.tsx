import { useEffect, useState } from 'react'
import { DEFAULT_SCOPES, SCOPE_LABELS, agentsCreate, agentsList, agentsRevoke, claudeCodeCommand, connectionKindLabel, desktopConfig, mcpUrl } from '../agents'
import type { AgentScope, AgentsInfo, CreatedToken } from '../agents'
import { fmtDate, timeAgo } from '../utils'
import { ConfirmButton } from './ConfirmButton'

/** The three calls the section makes; the defaults are src/agents.ts. */
export interface AssistantsApi {
  list(): Promise<AgentsInfo>
  create(input: { name: string; scopes: AgentScope[] }): Promise<CreatedToken>
  revoke(id: string): Promise<boolean>
}

const DEFAULT_API: AssistantsApi = { list: agentsList, create: agentsCreate, revoke: agentsRevoke }

interface Props {
  /** The section's classes. Settings shows one group at a time by `g-<group>`; this one is `g-assistants`. */
  className?: string
  /** The hosted MCP endpoint (default: this site's /api/mcp, the hosted site's on the phone). */
  connectorUrl?: string
  /** Where a checkout of Drafter keeps mcp/server.mjs, for the Claude Desktop entry (default: a placeholder). */
  serverPath?: string
  /** Tests and previews only. */
  api?: AssistantsApi
  /** Tests and previews: start from this instead of fetching. */
  initial?: AgentsInfo | null
}

function CopyRow({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-row">
      <input readOnly value={value} aria-label={label} onFocus={e => e.currentTarget.select()} />
      <button
        type="button"
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
          } catch {
            /* the field is selectable */
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * Settings → Assistants: connect the Claude app through its connector URL
 * (OAuth, consent in ConnectAssistantSheet), make a token for Claude Code or a
 * local server (shown once, then only its first characters), and see and
 * revoke every connection. Self-contained: it loads and changes connections
 * through /api/agents itself.
 */
export function AssistantsSection({ className = 'settings-section g-assistants', connectorUrl, serverPath, api = DEFAULT_API, initial = null }: Props) {
  const url = connectorUrl ?? mcpUrl()
  const [info, setInfo] = useState<AgentsInfo | null>(initial)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [canWrite, setCanWrite] = useState(DEFAULT_SCOPES.includes('write'))
  const [journal, setJournal] = useState(DEFAULT_SCOPES.includes('journal'))
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedToken | null>(null)

  useEffect(() => {
    if (initial) return
    let live = true
    api.list().then(
      next => {
        if (live) setInfo(next)
      },
      e => {
        if (live) setError((e as Error).message)
      },
    )
    return () => {
      live = false
    }
  }, [api, initial])

  const create = async () => {
    const clean = name.trim()
    if (!clean) return
    setBusy(true)
    setError('')
    try {
      const scopes: AgentScope[] = ['read', ...(canWrite ? (['write'] as const) : []), ...(journal ? (['journal'] as const) : [])]
      const out = await api.create({ name: clean, scopes })
      setCreated(out)
      setName('')
      setInfo(prev => (prev ? { ...prev, connections: [out.connection, ...prev.connections] } : prev))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    setError('')
    try {
      await api.revoke(id)
      setInfo(prev => (prev ? { ...prev, connections: prev.connections.filter(c => c.id !== id) } : prev))
      setCreated(prev => (prev?.connection.id === id ? null : prev))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className={className}>
      <h3>Assistants</h3>
      <p className="field-hint">
        Let Claude look things up in your planner and, if you allow it, add and change things. It acts as you and sees only what you see; your journal
        stays out unless you tick it.
      </p>

      {info && !info.configured ? (
        <p className="field-hint">Assistants aren’t set up on this site yet.</p>
      ) : (
        <>
          <h4>Claude app (web, iPhone, Android)</h4>
          <CopyRow value={url} label="Connector URL" />
          <p className="field-hint">
            In claude.ai → Settings → Connectors → <em>Add custom connector</em>, paste this address and sign in here when asked. It then appears in the
            Claude app on your phone too.
          </p>

          <h4>Claude Code and other apps</h4>
          {created ? (
            <>
              <p className="warn">Copy this token now — Drafter shows it only once. It acts as you: keep it like a password.</p>
              <CopyRow value={created.token} label="Token" />
              <div className="field">
                <span>Claude Code</span>
                <CopyRow value={claudeCodeCommand(created.token, url)} label="Claude Code command" />
              </div>
              <label className="field">
                <span>Claude Desktop (a local server) — add to claude_desktop_config.json</span>
                <textarea readOnly rows={7} value={desktopConfig(created.token, serverPath)} onFocus={e => e.currentTarget.select()} />
              </label>
              <p className="sync-line">
                <button type="button" className="btn" onClick={() => setCreated(null)}>
                  Done — I’ve copied it
                </button>
              </p>
            </>
          ) : (
            <>
              <div className="check-add">
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Name it, e.g. Claude Code on my laptop" maxLength={80} aria-label="Token name" />
                <button type="button" className="btn" disabled={busy || !name.trim()} onClick={() => void create()}>
                  {busy ? 'Creating…' : 'Create token'}
                </button>
              </div>
              <label className="cal-source mirror-row">
                <input type="checkbox" checked={canWrite} onChange={e => setCanWrite(e.target.checked)} disabled={busy} />
                <span className="cal-source-name">Can add and change things</span>
              </label>
              <label className="cal-source mirror-row">
                <input type="checkbox" checked={journal} onChange={e => setJournal(e.target.checked)} disabled={busy} />
                <span className="cal-source-name">Can read and write my journal</span>
              </label>
              <p className="field-hint">For Claude Code, Claude Desktop or any MCP client that sends a header.</p>
            </>
          )}

          <h4>Connected</h4>
          {info === null ? (
            <p className="field-hint">{error ? `Connections unavailable: ${error}` : 'Loading connections…'}</p>
          ) : info.connections.length === 0 ? (
            <p className="field-hint">Nothing is connected yet.</p>
          ) : (
            <ul className="cal-sources">
              {info.connections.map(c => (
                <li key={c.id} className="cal-source">
                  <span className="cal-source-name">
                    <strong>{c.name}</strong> <span className="tag">{connectionKindLabel(c)}</span>{' '}
                    {c.scopes.map(s => (
                      <span key={s} className="tag">
                        {SCOPE_LABELS[s]}
                      </span>
                    ))}{' '}
                    <small>
                      Connected {fmtDate(c.createdAt)} · {c.lastUsedAt ? `last used ${timeAgo(c.lastUsedAt)}` : 'never used'}
                      {c.tokenPrefix ? ` · ${c.tokenPrefix}…` : ''}
                    </small>
                  </span>
                  <ConfirmButton className="btn subtle danger" confirmLabel="Revoke?" onConfirm={() => void revoke(c.id)}>
                    Revoke
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
          {error && info !== null && <p className="warn">{error}</p>}
        </>
      )}
    </section>
  )
}
