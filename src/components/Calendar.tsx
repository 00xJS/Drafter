import { useMemo, useState } from 'react'
import { Post, STATUS_META } from '../types'
import { dateKey } from '../utils'

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
        <span className="cal-hint">Click a day to schedule a post · drag a pill to reschedule</span>
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
              onClick={() => {
                const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0)
                onNew(at.toISOString())
              }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/plain')
                if (id) onReschedule(id, d)
              }}
            >
              <div className="cal-daynum">{d.getDate()}</div>
              {shown.map(p => (
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
                  title={p.title || 'Untitled'}
                >
                  {p.title || 'Untitled'}
                </button>
              ))}
              {dayPosts.length > 3 && <div className="cal-more">+{dayPosts.length - 3} more</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
