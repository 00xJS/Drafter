import { useState } from 'react'
import { inboundAction } from '../../calendars'
import { ConfirmButton } from '../ConfirmButton'
import type { SettingsCtx } from './context'
import { useAsyncAction } from './useAsyncAction'

type InboundAction = 'inbound-enable' | 'inbound-rotate' | 'inbound-disable'

/** Put `text` on the clipboard: false where this browser or web view would not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Data → Email in: a private address that turns a forwarded email into a task. Shown once the feed service is. */
export function EmailIn({ feed: { feed, setFeed, feedBusy } }: SettingsCtx) {
  // Create, Reset and Turn off used to fail in silence and could be pressed
  // again while one was on its way; now each says so, under the address.
  const { busy, error, run } = useAsyncAction()
  const [doing, setDoing] = useState<InboundAction | null>(null)
  /** Whether the last Copy reached the clipboard; null until one is tried. */
  const [copied, setCopied] = useState<boolean | null>(null)
  if (!feed?.configured) return null

  const act = (action: InboundAction) => {
    // the subscribe link's own actions answer with the whole feed, this address included
    if (busy || feedBusy) return
    setDoing(action)
    void run(() => inboundAction(action).then(r => setFeed(f => (f ? { ...f, inboundUrl: r.inboundUrl } : f))))
  }
  const copy = async (url: string) => {
    const ok = await copyText(url)
    setCopied(ok)
    if (ok) window.setTimeout(() => setCopied(null), 2000)
  }
  const label = (action: InboundAction, idle: string, working: string) => (busy && doing === action ? working : idle)

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
          <button className="btn" onClick={() => void copy(feed.inboundUrl!)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {/* both stop the address that is set up in a forwarding rule somewhere, so each asks first */}
          <ConfirmButton className="btn subtle" confirmLabel="Tap again to reset — the old one stops" onConfirm={() => act('inbound-rotate')}>
            {label('inbound-rotate', 'Reset', 'Resetting…')}
          </ConfirmButton>
          <ConfirmButton className="btn subtle danger" confirmLabel="Tap again to turn it off" onConfirm={() => act('inbound-disable')}>
            {label('inbound-disable', 'Turn off', 'Turning off…')}
          </ConfirmButton>
        </div>
      ) : (
        <button className="btn" disabled={busy || feedBusy} onClick={() => act('inbound-enable')}>
          {label('inbound-enable', 'Create my email-in address', 'Creating…')}
        </button>
      )}
      {copied === false && <p className="field-hint">Copy did not work here — select the address and copy it.</p>}
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
