import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SCOPES,
  SCOPE_LABELS,
  TOKEN_IDLE_DAYS,
  agentsCreate,
  agentsList,
  agentsRename,
  agentsRevoke,
  claudeCodeCommand,
  connectionKindLabel,
  desktopConfig,
  expiryLine,
  mcpUrl,
  nameToSave,
  renameIn,
  withoutConnection,
} from '../agents'
import type { AgentConnection, AgentScope, AgentsInfo, CreatedToken } from '../agents'
import { fmtDate, timeAgo } from '../utils'
import { ConfirmButton } from './ConfirmButton'

/** The four calls the section makes; the defaults are src/agents.ts. */
export interface AssistantsApi {
  list(): Promise<AgentsInfo>
  create(input: { name: string; scopes: AgentScope[] }): Promise<CreatedToken>
  revoke(id: string): Promise<boolean>
  rename(id: string, name: string): Promise<boolean>
}

const DEFAULT_API: AssistantsApi = { list: agentsList, create: agentsCreate, revoke: agentsRevoke, rename: agentsRename }

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
 * One connection in the Connected list: what it is and may do, when it was
 * last used and, for a token, how it lapses. Rename turns its name into a
 * field in place, and Escape or Cancel puts the row back with focus on Rename;
 * Revoke asks twice.
 */
export function ConnectionRow({
  connection: c,
  onRename,
  onRevoke,
  startRenaming = false,
}: {
  connection: AgentConnection
  /** Resolves true once the server has the new name. */
  onRename(name: string): Promise<boolean>
  onRevoke(): void
  /** Tests and previews: open on the name field. */
  startRenaming?: boolean
}) {
  const [renaming, setRenaming] = useState(startRenaming)
  const [draft, setDraft] = useState(c.name)
  const [busy, setBusy] = useState(false)
  const renameButton = useRef<HTMLButtonElement>(null)
  // the field takes the row's place, so Rename is back to take focus only after the render that closes it
  const refocus = useRef(false)
  const expiry = expiryLine(c)

  useEffect(() => {
    if (renaming || !refocus.current) return
    refocus.current = false
    renameButton.current?.focus()
  }, [renaming])

  const close = () => {
    refocus.current = true
    setRenaming(false)
  }

  const cancel = () => {
    setDraft(c.name)
    close()
  }

  const save = async () => {
    const name = nameToSave(draft, c.name)
    if (!name) {
      close()
      return
    }
    setBusy(true)
    const done = await onRename(name)
    setBusy(false)
    if (done) close()
  }

  if (renaming) {
    return (
      <li className="cal-source">
        <form
          className="check-add"
          onSubmit={e => {
            e.preventDefault()
            void save()
          }}
        >
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              // handled here, and Settings (a Modal, which skips a handled key) stays open
              if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                cancel()
              }
            }}
            maxLength={80}
            aria-label={`New name for ${c.name}`}
            disabled={busy}
            autoFocus
          />
          <button type="submit" className="btn" disabled={busy || !draft.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn subtle" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </form>
      </li>
    )
  }

  return (
    <li className="cal-source">
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
          {expiry ? ` · ${expiry}` : ''}
        </small>
      </span>
      <button
        ref={renameButton}
        type="button"
        className="btn subtle"
        aria-label={`Rename ${c.name}`}
        onClick={() => {
          setDraft(c.name)
          setRenaming(true)
        }}
      >
        Rename
      </button>
      <ConfirmButton className="btn subtle danger" confirmLabel="Revoke?" onConfirm={onRevoke}>
        Revoke
      </ConfirmButton>
    </li>
  )
}

/**
 * Settings → Assistants: connect the Claude app through its connector URL
 * (OAuth, consent in ConnectAssistantSheet), make a token for Claude Code or a
 * local server (shown once, then only its first characters), and see, rename
 * and revoke every connection. Self-contained: it loads and changes
 * connections through /api/agents itself.
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
    const scopes: AgentScope[] = ['read', ...(canWrite ? (['write'] as const) : []), ...(journal ? (['journal'] as const) : [])]
    // no `finally`, and nothing in the try that picks a value: the React
    // Compiler leaves a component with either as written. A catch that only
    // sets state cannot throw past it.
    try {
      const out = await api.create({ name: clean, scopes })
      setCreated(out)
      setName('')
      setInfo(prev => (prev ? { ...prev, connections: [out.connection, ...prev.connections] } : prev))
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  const revoke = async (id: string) => {
    setError('')
    try {
      await api.revoke(id)
      setInfo(prev => (prev ? withoutConnection(prev, id) : prev))
      setCreated(prev => (prev?.connection.id === id ? null : prev))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** True once the server has the name. A connection it no longer has (revoked, or lapsed) leaves the list. */
  const rename = async (id: string, next: string): Promise<boolean> => {
    setError('')
    try {
      if (await api.rename(id, next)) {
        setInfo(prev => (prev ? renameIn(prev, id, next) : prev))
        return true
      }
      setError('That connection is gone: it was revoked, or it lapsed unused.')
      setInfo(prev => (prev ? withoutConnection(prev, id) : prev))
    } catch (e) {
      setError((e as Error).message)
    }
    return false
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
              <p className="field-hint">
                For Claude Code, Claude Desktop or any MCP client that sends a header. A token stops working after {TOKEN_IDLE_DAYS} days unused.
              </p>
            </>
          )}

          <h4>Connected</h4>
          {info === null ? (
            <p className="field-hint">{error ? `Connections unavailable: ${error}` : 'Loading connections…'}</p>
          ) : info.connections.length === 0 ? (
            <p className="field-hint">Nothing is connected yet.</p>
          ) : (
            <ul className="cal-sources agent-connections">
              {info.connections.map(c => (
                <ConnectionRow key={c.id} connection={c} onRename={next => rename(c.id, next)} onRevoke={() => void revoke(c.id)} />
              ))}
            </ul>
          )}
          {error && info !== null && <p className="warn">{error}</p>}
        </>
      )}
    </section>
  )
}
