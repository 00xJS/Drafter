import { useEffect, useState } from 'react'
import { GITHUB_STATE_META, GithubCard as Card, fetchGithubCard, githubLabel, parseGithubUrl, setIssueState } from '../github'
import { readableInk } from '../contrast'
import { useTheme } from '../theme'
import { timeAgo } from '../utils'
import { useNow } from '../useNow'

interface Props {
  url: string
  /** Offered when the URL is the task's own link (not just one in its description): clears it. */
  onUnlink?(): void
}

/** Live status card for a GitHub issue / PR / repo / project URL. */
export function GithubCard({ url, onUnlink }: Props) {
  const ref = parseGithubUrl(url)
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(() => !!ref)
  // a label keeps its GitHub colour, moved only as far as it takes to read on
  // the card's own ground (--surface-2, 'raised')
  const theme = useTheme()

  // the relative time moves on with the clock, not only when the card reloads
  const now = useNow()

  // No `finally` here, and nothing in a try that picks a value: the React
  // Compiler leaves a component with either as written. A catch that only
  // sets state cannot throw past what follows it.
  const load = async (force = false) => {
    if (!ref) return
    setBusy(true)
    setError('')
    try {
      setCard(await fetchGithubCard(url, force))
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  // another link: its card, never the last one's, from the render that shows it
  const [cardFor, setCardFor] = useState(url)
  if (cardFor !== url) {
    setCardFor(url)
    setCard(null)
    setError('')
    setBusy(!!ref)
  }
  useEffect(() => {
    if (!parseGithubUrl(url)) return
    // an answer for a link since replaced is dropped
    let live = true
    fetchGithubCard(url)
      .then(
        c => live && setCard(c),
        (e: Error) => live && setError(e.message),
      )
      .finally(() => live && setBusy(false))
    return () => {
      live = false
    }
  }, [url])

  if (!ref)
    return (
      <p className="field-hint warn">
        Not a GitHub issue, pull request, repository or project URL.{' '}
        {onUnlink && (
          <button type="button" className="btn subtle" onClick={onUnlink}>
            Unlink
          </button>
        )}
      </p>
    )

  const glyph = ref.type === 'pr' ? '⎇' : ref.type === 'issue' ? '◉' : ref.type === 'project' ? '▦' : '⌥'
  const state = card ? GITHUB_STATE_META[card.state] : null

  return (
    <div className="gh-card">
      <div className="gh-head">
        <span className="gh-glyph" aria-hidden>
          {glyph}
        </span>
        <a href={card?.url ?? url} target="_blank" rel="noreferrer" className="gh-title">
          {card?.title ?? githubLabel(ref)}
        </a>
        {state && (
          <span className="badge" style={{ background: state.bg, color: state.color }}>
            {state.label}
          </span>
        )}
        <button type="button" className="btn subtle gh-refresh" disabled={busy} onClick={() => load(true)} aria-label="Refresh">
          {busy ? '…' : '↻'}
        </button>
        {onUnlink && (
          <button type="button" className="btn subtle gh-refresh" onClick={onUnlink} aria-label="Unlink from this task" title="Unlink from this task">
            ✕
          </button>
        )}
      </div>
      <div className="gh-sub">
        <span>{githubLabel(ref)}</span>
        {card?.milestone && <span>◆ {card.milestone}</span>}
        {card?.assignees && card.assignees.length > 0 && <span>@{card.assignees.join(', @')}</span>}
        {card?.comments !== undefined && card.comments > 0 && <span>💬 {card.comments}</span>}
        {card?.type === 'repo' && card.openIssues !== undefined && <span>{card.openIssues} open issues</span>}
        {card?.type === 'repo' && card.stars !== undefined && <span>★ {card.stars}</span>}
        {card?.type === 'project' && card.items !== undefined && <span>{card.items} items</span>}
        {card?.updatedAt && <span>updated {timeAgo(card.updatedAt, now)}</span>}
      </div>
      {card?.description && <p className="gh-desc">{card.description}</p>}
      {card && card.labels.length > 0 && (
        <div className="gh-labels">
          {card.labels.map(l => (
            <span key={l.name} className="gh-label" style={l.color ? { borderColor: l.color, color: readableInk(l.color, theme, { ground: 'raised' }) } : undefined}>
              {l.name}
            </span>
          ))}
        </div>
      )}
      {card?.canWrite && (card.type === 'issue' || card.type === 'pr') && card.type === 'issue' && (
        <div className="ai-row">
          <button
            type="button"
            className="btn subtle"
            disabled={busy}
            onClick={async () => {
              const next = card.state === 'open' ? 'close' : 'reopen'
              setBusy(true)
              setError('')
              try {
                await setIssueState(url, next)
                await load(true)
              } catch (e) {
                setError((e as Error).message)
              }
              setBusy(false)
            }}
          >
            {card.state === 'open' ? 'Close issue on GitHub' : 'Reopen issue'}
          </button>
        </div>
      )}
      {error && <p className="field-hint warn">{error}</p>}
    </div>
  )
}
