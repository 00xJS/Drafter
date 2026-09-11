import { useState } from 'react'
import { Habit, PROJECT_COLORS } from '../types'
import { newerStamp } from '../itemops'
import { uid } from '../utils'
import { isDueOn, isDoneOn, streakOf, toggleDone } from '../habits'
import { ConfirmButton } from './ConfirmButton'

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/**
 * Today's habits: tick the ones due today, watch the streak grow. Habits are
 * personal and their completions live on the record, so a tick is one small
 * write. The card sits on the Today dashboard; managing them (add, rename,
 * reschedule, delete) happens in place rather than on a tab of their own.
 */
export function HabitsCard({ habits, today, onSave, onDelete }: { habits: Habit[]; today: string; onSave(h: Habit): void; onDelete(id: string): void }) {
  const now = new Date()
  const [editing, setEditing] = useState<string | null>(null) // habit id, or 'new'
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const [days, setDays] = useState<Set<number>>(new Set())

  const openNew = () => {
    setEditing('new')
    setName('')
    setEmoji('')
    setDays(new Set())
  }
  const openEdit = (h: Habit) => {
    setEditing(h.id)
    setName(h.name)
    setEmoji(h.emoji ?? '')
    setDays(new Set(h.days ?? []))
  }
  const close = () => setEditing(null)
  const toggleDay = (d: number) => setDays(s => (s.has(d) ? new Set([...s].filter(x => x !== d)) : new Set(s).add(d)))

  const save = () => {
    const n = name.trim()
    if (!n) return
    const dayList = days.size === 0 || days.size === 7 ? undefined : [...days].sort((a, b) => a - b)
    const stamp = new Date().toISOString()
    if (editing === 'new') {
      onSave({
        kind: 'habit',
        id: uid(),
        name: n,
        emoji: emoji.trim() || undefined,
        color: PROJECT_COLORS[habits.length % PROJECT_COLORS.length],
        days: dayList,
        done: [],
        order: habits.length,
        createdAt: stamp,
        updatedAt: stamp,
      })
    } else {
      const h = habits.find(x => x.id === editing)
      if (h) onSave({ ...h, name: n, emoji: emoji.trim() || undefined, days: dayList, updatedAt: newerStamp(h.updatedAt) })
    }
    close()
  }

  const tick = (h: Habit) => onSave(toggleDone(h, today))

  return (
    <section className="chart-card habits-card">
      <header className="chart-head">
        <div>
          <h3>Habits</h3>
          <p className="chart-sub">Tick what you did today — keep the streak</p>
        </div>
        {editing !== 'new' && (
          <button type="button" className="btn subtle" onClick={openNew}>
            + Add
          </button>
        )}
      </header>

      {editing === 'new' && <HabitForm {...{ name, setName, emoji, setEmoji, days, WEEKDAY_LETTERS, toggleDay, save, close }} isNew />}

      {habits.length === 0 && editing !== 'new' ? (
        <p className="empty">No habits yet. Add one — a daily walk, water, ten minutes of reading.</p>
      ) : (
        <ul className="habit-list">
          {habits.map(h =>
            editing === h.id ? (
              <li key={h.id}>
                <HabitForm
                  {...{ name, setName, emoji, setEmoji, days, WEEKDAY_LETTERS, toggleDay, save, close }}
                  isNew={false}
                  onDelete={() => {
                    onDelete(h.id)
                    close()
                  }}
                />
              </li>
            ) : (
              <li key={h.id} className={'habit-row' + (isDueOn(h, now) ? '' : ' rest')}>
                <button
                  type="button"
                  className={'habit-tick' + (isDoneOn(h, today) ? ' on' : '')}
                  style={isDoneOn(h, today) ? { background: h.color, borderColor: h.color } : { borderColor: h.color }}
                  onClick={() => tick(h)}
                  aria-pressed={isDoneOn(h, today)}
                  aria-label={isDoneOn(h, today) ? `Undo ${h.name} for today` : `Mark ${h.name} done today`}
                >
                  {isDoneOn(h, today) ? '✓' : ''}
                </button>
                <button type="button" className="habit-name" onClick={() => openEdit(h)} title="Edit habit">
                  {h.emoji ? <span className="habit-emoji">{h.emoji}</span> : null}
                  <span>{h.name}</span>
                </button>
                <span className="habit-streak">{isDueOn(h, now) ? (streakOf(h, now) > 0 ? `🔥 ${streakOf(h, now)}` : '') : 'Rest day'}</span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  )
}

function HabitForm({
  name,
  setName,
  emoji,
  setEmoji,
  days,
  WEEKDAY_LETTERS,
  toggleDay,
  save,
  close,
  isNew,
  onDelete,
}: {
  name: string
  setName(s: string): void
  emoji: string
  setEmoji(s: string): void
  days: Set<number>
  WEEKDAY_LETTERS: string[]
  toggleDay(d: number): void
  save(): void
  close(): void
  isNew: boolean
  onDelete?(): void
}) {
  return (
    <div className="habit-form">
      <div className="habit-form-top">
        <input className="habit-emoji-input" value={emoji} onChange={e => setEmoji(e.target.value.slice(0, 2))} placeholder="🙂" aria-label="Emoji" />
        <input
          className="habit-name-input"
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            }
            if (e.key === 'Escape') close()
          }}
          placeholder="New habit — e.g. Walk, Water, Read"
          aria-label="Habit name"
        />
      </div>
      <div className="habit-days" role="group" aria-label="Days it's due (none = every day)">
        {WEEKDAY_LETTERS.map((letter, d) => (
          <button key={d} type="button" className={'habit-day' + (days.has(d) ? ' on' : '')} onClick={() => toggleDay(d)} aria-pressed={days.has(d)} aria-label={`Weekday ${d}`}>
            {letter}
          </button>
        ))}
        <span className="habit-days-hint">{days.size === 0 || days.size === 7 ? 'Every day' : 'Chosen days'}</span>
      </div>
      <div className="habit-form-actions">
        <button type="button" className="btn primary" onClick={save} disabled={!name.trim()}>
          {isNew ? 'Add habit' : 'Save'}
        </button>
        <button type="button" className="btn subtle" onClick={close}>
          Cancel
        </button>
        {onDelete && (
          <ConfirmButton className="btn subtle danger habit-delete" onConfirm={onDelete}>
            Delete
          </ConfirmButton>
        )}
      </div>
    </div>
  )
}
