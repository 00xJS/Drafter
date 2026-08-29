import { useMemo, useState } from 'react'
import { PLATFORM_META, Post, STATUS_META } from '../types'
import { dateKey, fmtTime } from '../utils'

interface Props {
  posts: Post[]
  onOpen(p: Post): void
  onNew(scheduledForIso: string): void
  onReschedule(id: string, day: Date): void
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function postDate(p: Post): string | undefined {
  if (p.status === 'canceled') return undefined
  if (p.status === 'posted') return p.postedAt ?? p.scheduledFor
  return p.scheduledFor
}

export function Calendar({ posts, onOpen, onNew, onReschedule }: Props) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [sheetDay, setSheetDay] = useState<Date | null>(null)

  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>()
    for (const p of posts) {
      const d = postDate(p)
      if (!d) continue
      const k = dateKey(d)
      const arr = map.get(k) ?? []
      arr.push(p)
      map.set(k, arr)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (postDate(a) ?? '').localeCompare(postDate(b) ?? ''))
    }
    return map
  }, [posts])

  const cells = useMemo(() => {
    const offset = (cursor.getDay() + 6) % 7 // Monday-start week
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    const total = Math.ceil((offset + daysInMonth) / 7) * 7
    const out: Date[] = []
    for (let i = 0; i < total; i++) {
      out.push(new Date(cursor.getFullYear(), cursor.getMonth(), 1 - offset + i))
    }
    return out
  }, [cursor])

  const todayKey = dateKey(new Date())
  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const shift = (delta: number) => setCursor(c => new Date(c.getFullYear(), c.getMonth() + delta, 1))
  const sheetPosts = sheetDay ? (byDay.get(dateKey(sheetDay)) ?? []) : []

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <button className="btn" onClick={() => shift(-1)} aria-label="Previous month">
          ‹
        </button>
        <h2>{monthLabel}</h2>
        <button className="btn" onClick={() => shift(1)} aria-label="Next month">
          ›
        </button>
        <button
          className="btn subtle"
          onClick={() =>
            setCursor(() => {
              const now = new Date()
              return new Date(now.getFullYear(), now.getMonth(), 1)
            })
          }
        >
          Today
        </button>
        <span className="cal-hint">Tap a day for its schedule · drag a pill to reschedule</span>
      </div>

      <div className="cal-grid cal-head-row">
        {WEEKDAYS.map(d => (
          <div key={d} className="cal-head">
            {d}
          </div>
        ))}
      </div>
      <div className="cal-grid cal-body">
        {cells.map(d => {
          const k = dateKey(d)
          const inMonth = d.getMonth() === cursor.getMonth()
          const dayPosts = byDay.get(k) ?? []
          const shown = dayPosts.slice(0, 3)
          return (
            <div
              key={k}
              className={'cal-cell' + (inMonth ? '' : ' out') + (k === todayKey ? ' today' : '')}
              onClick={() => setSheetDay(d)}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/plain')
                if (id) onReschedule(id, d)
              }}
            >
              <div className="cal-daynum">{d.getDate()}</div>
              {shown.map(p => {
                const when = postDate(p)
                return (
                  <button
                    key={p.id}
                    className="cal-pill"
                    style={{ background: STATUS_META[p.status].bg, color: STATUS_META[p.status].color }}
                    draggable={p.status !== 'posted'}
                    onDragStart={e => {
                      e.dataTransfer.setData('text/plain', p.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={e => {
                      e.stopPropagation()
                      onOpen(p)
                    }}
                    title={`${when ? fmtTime(when) + ' · ' : ''}${p.title || 'Untitled'}`}
                  >
                    {when && <span className="cal-pill-time">{fmtTime(when)}</span>}
                    <span className="cal-pill-title">{p.title || 'Untitled'}</span>
                  </button>
                )
              })}
              {dayPosts.length > 3 && <div className="cal-more">+{dayPosts.length - 3} more</div>}
            </div>
          )
        })}
      </div>

      {sheetDay && (
        <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setSheetDay(null)}>
          <div className="modal narrow day-sheet" role="dialog" aria-modal="true">
            <header className="modal-head">
              <h2>{sheetDay.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
              <button className="btn subtle" onClick={() => setSheetDay(null)} aria-label="Close">
                ✕
              </button>
            </header>
            <div className="modal-body">
              {sheetPosts.length === 0 ? (
                <p className="empty">Nothing on this day yet.</p>
              ) : (
                <ul className="dash-list">
                  {sheetPosts.map(p => (
                    <li
                      key={p.id}
                      onClick={() => {
                        setSheetDay(null)
                        onOpen(p)
                      }}
                    >
                      <div className="dash-main">
                        <span className="dash-title">{p.title || p.body.slice(0, 50) || 'Untitled'}</span>
                        <span className="dash-meta">
                          <span
                            className="badge"
                            style={{ background: STATUS_META[p.status].bg, color: STATUS_META[p.status].color }}
                          >
                            {STATUS_META[p.status].label}
                          </span>
                          {p.platforms.map(pl => (
                            <span key={pl} className="chip platform" style={{ background: PLATFORM_META[pl].color }}>
                              {PLATFORM_META[pl].short}
                            </span>
                          ))}
                        </span>
                      </div>
                      <strong className="day-time">{fmtTime(postDate(p))}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <footer className="modal-foot">
              <span className="spacer" />
              <button
                className="btn primary"
                onClick={() => {
                  const at = new Date(sheetDay.getFullYear(), sheetDay.getMonth(), sheetDay.getDate(), 9, 0, 0)
                  setSheetDay(null)
                  onNew(at.toISOString())
                }}
              >
                + New post this day
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
