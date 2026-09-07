import { useMemo, useState } from 'react'
import { Project, STATUS_META, Task } from '../types'
import { dateKey, fmtTime } from '../utils'
import { ProjectChip } from './bits'

interface Props {
  tasks: Task[]
  projectMap: Map<string, Project>
  onOpen(t: Task): void
  onNew(dueAtIso: string): void
  onReschedule(id: string, day: Date): void
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_PILLS = 3

/** The day a task shows on: its due date, or the day it was completed. */
function taskDate(t: Task): string | undefined {
  if (t.status === 'canceled') return undefined
  if (t.status === 'done') return t.completedAt ?? t.dueAt
  return t.dueAt
}

function hasClock(iso: string): boolean {
  const d = new Date(iso)
  return d.getHours() + d.getMinutes() > 0
}

export function Calendar({ tasks, projectMap, onOpen, onNew, onReschedule }: Props) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [sheetDay, setSheetDay] = useState<Date | null>(null)

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      const d = taskDate(t)
      if (!d) continue
      const k = dateKey(d)
      const arr = map.get(k) ?? []
      arr.push(t)
      map.set(k, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => (taskDate(a) ?? '').localeCompare(taskDate(b) ?? ''))
    return map
  }, [tasks])

  const cells = useMemo(() => {
    const offset = cursor.getDay() // Sunday-start week
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    const total = Math.ceil((offset + daysInMonth) / 7) * 7
    const out: Date[] = []
    for (let i = 0; i < total; i++) out.push(new Date(cursor.getFullYear(), cursor.getMonth(), 1 - offset + i))
    return out
  }, [cursor])

  const todayKey = dateKey(new Date())
  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const shift = (delta: number) => setCursor(c => new Date(c.getFullYear(), c.getMonth() + delta, 1))
  const sheetTasks = sheetDay ? (byDay.get(dateKey(sheetDay)) ?? []) : []

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
        <span className="cal-hint">Tap a day for its tasks · drag a pill to move its due date</span>
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
          const dayTasks = byDay.get(k) ?? []
          // cells have a fixed height: when a day overflows, trade the last pill for the "+N more" line
          const shown = dayTasks.length > MAX_PILLS ? dayTasks.slice(0, MAX_PILLS - 1) : dayTasks
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
              {shown.map(t => {
                const when = taskDate(t)
                const project = t.projectId ? projectMap.get(t.projectId) : undefined
                return (
                  <button
                    key={t.id}
                    className={t.status === 'done' ? 'cal-pill done' : 'cal-pill'}
                    style={{
                      background: project ? project.color + '22' : STATUS_META[t.status].bg,
                      color: project ? project.color : STATUS_META[t.status].color,
                    }}
                    draggable={t.status !== 'done'}
                    onDragStart={e => {
                      e.dataTransfer.setData('text/plain', t.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={e => {
                      e.stopPropagation()
                      onOpen(t)
                    }}
                    title={`${when && hasClock(when) ? fmtTime(when) + ' · ' : ''}${t.title || 'Untitled'}${project ? ' · ' + project.name : ''}`}
                  >
                    {when && hasClock(when) && <span className="cal-pill-time">{fmtTime(when)}</span>}
                    <span className="cal-pill-title">{t.title || 'Untitled'}</span>
                  </button>
                )
              })}
              {dayTasks.length > shown.length && <div className="cal-more">+{dayTasks.length - shown.length} more</div>}
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
              {sheetTasks.length === 0 ? (
                <p className="empty">Nothing on this day yet.</p>
              ) : (
                <ul className="dash-list">
                  {sheetTasks.map(t => {
                    const when = taskDate(t)
                    const project = t.projectId ? projectMap.get(t.projectId) : undefined
                    return (
                      <li
                        key={t.id}
                        onClick={() => {
                          setSheetDay(null)
                          onOpen(t)
                        }}
                      >
                        <div className="dash-main">
                          <span className="dash-title">{t.title || t.description.slice(0, 50) || 'Untitled'}</span>
                          <span className="dash-meta">
                            <span className="badge" style={{ background: STATUS_META[t.status].bg, color: STATUS_META[t.status].color }}>
                              {STATUS_META[t.status].label}
                            </span>
                            {project && <ProjectChip project={project} />}
                          </span>
                        </div>
                        {when && hasClock(when) && <strong className="day-time">{fmtTime(when)}</strong>}
                      </li>
                    )
                  })}
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
                + New task this day
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
