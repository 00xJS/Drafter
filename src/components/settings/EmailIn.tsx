import { inboundAction } from '../../calendars'
import type { SettingsCtx } from './context'

/** Data → Email in: a private address that turns a forwarded email into a task. Shown once the feed service is. */
export function EmailIn({ feed: { feed, setFeed, feedBusy } }: SettingsCtx) {
  if (!feed?.configured) return null
  return (
    <section className="settings-section g-data">
      <h3>Email in</h3>
      <p className="field-hint">
        Forward an email and it becomes a task (subject → title, body → description, first link → link). Point a
        forwarding rule at this address: Mailgun Routes, SendGrid Inbound Parse, Cloudflare Email Workers, Zapier or
        Make all can call it. The link is yours alone — reset it if it leaks.
      </p>
      {feed.inboundUrl ? (
        <div className="copy-row">
          <input readOnly value={feed.inboundUrl} onFocus={e => e.currentTarget.select()} />
          <button className="btn" onClick={() => navigator.clipboard.writeText(feed.inboundUrl!).catch(() => {})}>
            Copy
          </button>
          <button className="btn subtle" disabled={feedBusy} onClick={() => inboundAction('inbound-rotate').then(r => setFeed(f => (f ? { ...f, inboundUrl: r.inboundUrl } : f)))}>
            Reset
          </button>
          <button className="btn subtle danger" disabled={feedBusy} onClick={() => inboundAction('inbound-disable').then(r => setFeed(f => (f ? { ...f, inboundUrl: r.inboundUrl } : f)))}>
            Turn off
          </button>
        </div>
      ) : (
        <button className="btn" disabled={feedBusy} onClick={() => inboundAction('inbound-enable').then(r => setFeed(f => (f ? { ...f, inboundUrl: r.inboundUrl } : f)))}>
          Create my email-in address
        </button>
      )}
    </section>
  )
}
