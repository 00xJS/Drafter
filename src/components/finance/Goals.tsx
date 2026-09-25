import { billEmoji, formatMoney } from '../../bills'
import type { GoalView } from '../../finance'
import type { Task } from '../../types'
import { PER, shortDay } from './labels'

// A savings goal is a repeating set-aside with the target on it (+ Goal,
// billtemplates.ts), and what it has saved is what its set-asides paid in
// (savingGoals). The main view shows each as a row with its bar; Manage's
// Goals shows the whole card: by when, how much each time, and what it needs.

const STATUS_WORDS: Record<GoalView['status'], string> = { reached: 'Reached', 'on-track': 'On track', behind: 'Behind', open: 'No date' }

const goalName = (g: GoalView) => g.task.title.trim() || 'Savings'

/** A goal on the main view: its name, how far it has got, and its bar. A tap opens its next set-aside. */
export function GoalRow({ goal: g, onOpen }: { goal: GoalView; onOpen(t: Task): void }) {
  return (
    <button type="button" className={`fin-goal-row ${g.status}`} onClick={() => onOpen(g.task)}>
      <span className="fin-goal-emoji" aria-hidden="true">
        {billEmoji(g.task.bill)}
      </span>
      <span className="fin-goal-row-copy">
        <span className="fin-goal-row-head">
          <strong>{goalName(g)}</strong>
          <span className={`fin-status ${g.status}`}>{STATUS_WORDS[g.status]}</span>
        </span>
        <span className="fin-bar" aria-hidden="true">
          <span style={{ width: `${g.pct}%` }} />
        </span>
        <small>
          {formatMoney(g.saved)} of {formatMoney(g.target)}
          {g.by ? ` · by ${shortDay(g.by)}` : ''}
        </small>
      </span>
    </button>
  )
}

/** A savings goal in full: how far it has got, by when, and what goes in each time. A tap opens its next set-aside. */
export function GoalCard({ goal: g, onOpen }: { goal: GoalView; onOpen(t: Task): void }) {
  const each = g.each !== undefined && g.freq ? `${formatMoney(g.each)} ${PER[g.freq]}` : 'No amount set'
  const next = g.next && g.status !== 'reached' ? ` · next ${shortDay(g.next)}` : ''
  const help = g.status === 'behind' && g.needed !== undefined ? ` · ${formatMoney(g.needed)} each would get there` : g.status === 'open' && g.toGo ? ` · ${g.toGo} more to go` : ''
  return (
    <button type="button" className={`fin-goal ${g.status}`} onClick={() => onOpen(g.task)}>
      <span className="fin-goal-head">
        <span className="fin-goal-emoji" aria-hidden="true">
          {billEmoji(g.task.bill)}
        </span>
        <strong>{goalName(g)}</strong>
        <span className={`fin-status ${g.status}`}>{STATUS_WORDS[g.status]}</span>
      </span>
      <span className="fin-bar" aria-hidden="true">
        <span style={{ width: `${g.pct}%` }} />
      </span>
      <span className="fin-goal-line">
        <strong>{formatMoney(g.saved)}</strong> of {formatMoney(g.target)}
        {g.by ? ` · by ${shortDay(g.by)}` : ''}
      </span>
      <small>
        {each}
        {next}
        {help}
      </small>
    </button>
  )
}
