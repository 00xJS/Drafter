import { useState } from 'react'
import { isGoogleSource, isMicrosoftSource } from '../../calendars'
import { newerStamp } from '../../itemops'
import { PROJECT_COLORS } from '../../types'
import { timeAgo, uid } from '../../utils'
import { ConfirmButton } from '../ConfirmButton'
import type { SettingsCtx } from './context'

/** Calendars → any .ics address (iCloud, holidays, a Google secret link), and the refresh line for every calendar. */
export function OtherCalendars({ store, calendars }: SettingsCtx) {
  const [calName, setCalName] = useState('')
  const [calUrl, setCalUrl] = useState('')
  const [calColor, setCalColor] = useState(PROJECT_COLORS[3])

  const addCalendar = () => {
    const url = calUrl.trim().replace(/^webcal:\/\//i, 'https://')
    if (!url) return
    const now = new Date().toISOString()
    store.upsert({ kind: 'calendar', id: uid(), name: calName.trim() || 'Calendar', url, color: calColor, enabled: true, createdAt: now, updatedAt: now })
    setCalName('')
    setCalUrl('')
  }

  return (
    <>
      <h4>Other calendars (iCloud, holidays, any .ics link)</h4>
      {store.calendars.filter(c => !isGoogleSource(c) && !isMicrosoftSource(c)).length > 0 && (
        <ul className="cal-sources">
          {store.calendars.filter(c => !isGoogleSource(c) && !isMicrosoftSource(c)).map(c => (
            <li key={c.id} className="cal-source">
              <input
                type="checkbox"
                checked={c.enabled}
                aria-label="Enabled"
                onChange={e => store.upsert({ ...c, enabled: e.target.checked, updatedAt: newerStamp(c.updatedAt) })}
              />
              <span className="pdot" style={{ background: c.color }} />
              <span className="cal-source-name">
                {c.name}
                {calendars.names[c.id] && calendars.names[c.id] !== c.name && <small> · {calendars.names[c.id]}</small>}
              </span>
              <span className="cal-source-status">
                {calendars.errors[c.id] ? (
                  <span className="warn">{calendars.errors[c.id]}</span>
                ) : (
                  <small>{calendars.events.filter(e => e.sourceId === c.id).length} events</small>
                )}
              </span>
              <ConfirmButton className="btn subtle danger" confirmLabel="Sure?" onConfirm={() => store.remove(c.id)}>
                Remove
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <div className="cal-add">
        <input value={calName} onChange={e => setCalName(e.target.value)} placeholder="Name (e.g. Family)" className="cal-add-name" />
        <input value={calUrl} onChange={e => setCalUrl(e.target.value)} placeholder="https://… or webcal://… (.ics address)" className="cal-add-url" />
        <span className="swatches small">
          {PROJECT_COLORS.map(c => (
            <button key={c} type="button" className={calColor === c ? 'swatch on' : 'swatch'} style={{ background: c }} onClick={() => setCalColor(c)} aria-label={c} />
          ))}
        </span>
        <button className="btn" disabled={!calUrl.trim()} onClick={addCalendar}>
          Add calendar
        </button>
      </div>
      <p className="field-hint">
        <strong>Google:</strong> calendar settings → <em>Integrate calendar</em> → copy the <em>Secret address in
        iCal format</em>. <strong>iCloud:</strong> Calendar app → share the calendar → tick <em>Public Calendar</em> →
        copy the webcal link. Both stay private to this app; the addresses are stored with your data, never in the
        page.
      </p>
      <p className="sync-line">
        {calendars.error ? (
          <span className="warn">{calendars.error}</span>
        ) : calendars.lastAt ? (
          <small>Events refreshed {timeAgo(calendars.lastAt)}.</small>
        ) : null}{' '}
        {store.calendars.length > 0 && (
          <button className="btn" disabled={calendars.loading} onClick={() => calendars.refresh()}>
            {calendars.loading ? 'Refreshing…' : 'Refresh now'}
          </button>
        )}
      </p>
    </>
  )
}
