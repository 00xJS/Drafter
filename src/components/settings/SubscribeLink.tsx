import { useState } from 'react'
import type { SettingsCtx } from './context'

/** Calendars → the private feed address any calendar app can subscribe to. */
export function SubscribeLink({ feed: { feed, feedError, feedBusy, runFeed } }: SettingsCtx) {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <h4>Subscribe link for Apple Calendar (or any calendar app)</h4>
      {feed?.enabled && feed.url ? (
        <>
          <p className="field-hint">
            Subscribe once (Apple Calendar → <em>File → New Calendar Subscription</em>; Google → <em>Other calendars →
            From URL</em>). Open tasks with due dates, project targets and milestones appear there and stay in sync.
            The link is yours alone and works like a password — reset it if it leaks.
          </p>
          <div className="copy-row">
            <input readOnly value={feed.url} onFocus={e => e.currentTarget.select()} />
            <button
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(feed.url!)
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 2000)
                } catch {
                  /* the field is selectable */
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn subtle" disabled={feedBusy} onClick={() => runFeed('rotate')}>
              Reset link
            </button>
            <button className="btn subtle danger" disabled={feedBusy} onClick={() => runFeed('disable')}>
              Turn off
            </button>
          </div>
        </>
      ) : feed?.configured ? (
        <p className="sync-line">
          <button className="btn" disabled={feedBusy} onClick={() => runFeed('enable')}>
            {feedBusy ? 'Creating…' : 'Create my subscribe link'}
          </button>
          <small>Generates a private feed address for your account.</small>
        </p>
      ) : feed ? (
        <p className="field-hint">Subscribe link isn’t available yet.</p>
      ) : (
        <p className="field-hint">{feedError ? `Feed status unavailable: ${feedError}` : 'Checking feed status…'}</p>
      )}
      {feedError && feed && <p className="warn">{feedError}</p>}
    </>
  )
}
