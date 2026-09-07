import { useEffect, useState } from 'react'
import { GITHUB_STATE_META, GithubCard as Card, fetchGithubCard, githubLabel, parseGithubUrl, setIssueState } from '../github'
import { timeAgo } from '../utils'

interface Props {
  url: string
}

/** Live status card for a GitHub issue / PR / repo / project URL. */
export function GithubCard({ url }: Props) {
  const ref = parseGithubUrl(url)
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (force = false) => {
    if (!ref) return
    setBusy(true)
    setError('')
    try {
      setCard(await fetchGithubCard(url, force))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    setCard(null)
    if (ref) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  if (!ref) return <p className="field-hint warn">Not a GitHub issue, pull request, repository or project URL.</p>

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
      </div>
      <div className="gh-sub">
        <span>{githubLabel(ref)}</span>
        {card?.milestone && <span>◆ {card.milestone}</span>}
        {card?.assignees && card.assignees.length > 0 && <span>@{card.assignees.join(', @')}</span>}
        {card?.comments !== undefined && card.comments > 0 && <span>💬 {card.comments}</span>}
        {card?.type === 'repo' && card.openIssues !== undefined && <span>{card.openIssues} open issues</span>}
        {card?.type === 'repo' && card.stars !== undefined && <span>★ {card.stars}</span>}
        {card?.type === 'project' && card.items !== undefined && <span>{card.items} items</span>}
        {card?.updatedAt && <span>updated {timeAgo(card.updatedAt)}</span>}
      </div>
      {card?.description && <p className="gh-desc">{card.description}</p>}
      {card && card.labels.length > 0 && (
        <div className="gh-labels">
          {card.labels.map(l => (
            <span key={l.name} className="gh-label" style={l.color ? { borderColor: l.color, color: l.color } : undefined}>
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
              setBusy(true)
              setError('')
              try {
                await setIssueState(url, card.state === 'open' ? 'close' : 'reopen')
                await load(true)
              } catch (e) {
                setError((e as Error).message)
              } finally {
                setBusy(false)
              }
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
