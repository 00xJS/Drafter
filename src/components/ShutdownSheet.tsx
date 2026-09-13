import { useMemo, useState } from 'react'
import { JournalEntry, OPEN_STATUSES, Person, Project, Review, Routine, Task } from '../types'
import { MAX_FOCUS, focusCandidates, leftovers } from '../focus'
import type { FocusCandidate, FocusGroup, ShutdownResult } from '../focus'
import { isFocusFor } from '../../shared/today.mjs'
import { entryOn } from '../journal'
import { DueBadge } from './bits'
import { JournalEditor } from './Journal'
import { Modal, ModalHead } from './Modal'
import { FocusPicker, MoveChips } from './PlanDaySheet'
import type { MoveTo } from './PlanDaySheet'
import { RoutineTicks } from './RoutinesCard'

// The "Day closed" note lives in src/dayclose.ts, so Today and the planner can
// use it without loading this sheet's chunk; re-exported for existing callers.
export { closeDay, dayClosed, reopenDay, shutdownKey } from '../dayclose'

const LEFTOVER_MOVES: readonly MoveTo[] = ['tomorrow', 'nextweek', 'wishlist', 'done']
const TOMORROW_GROUPS: Record<FocusGroup, string> = { carried: 'From your focus', dueToday: 'Due tomorrow', weekTop: 'This week’s 3', nextUp: 'Next up' }

/**
 * focusCandidates speaks from tomorrow morning's side ("due today", "from
 * yesterday"); in the evening those read one day off, so say them from tonight.
 */
export function tonightReason(c: FocusCandidate): string {
  const r = c.reason
  if (c.group === 'carried') {
    if (r === 'from yesterday') return 'today’s focus'
    const ago = /^from (\d+) days ago$/.exec(r)
    if (ago) {
      const n = Number(ago[1]) - 1
      return n === 1 ? 'from yesterday' : `from ${n} days ago`
    }
    return r
  }
  if (r === 'moved to today') return 'moved to tomorrow'
  if (r === 'due today' || /^due \d+h ago$/.test(r)) return 'due tomorrow'
  if (r === 'due tomorrow') return 'due the day after'
  if (c.group === 'dueToday' && r.startsWith('due ')) return `${r} tomorrow`
  return r
}

interface Props {
  /** The tasks the planner shows (Mine / Everyone applied). */
  tasks: Task[]
  projects: Project[]
  reviews: Review[]
  /** Your routines; the evening ones are ticked here. */
  routines: Routine[]
  /** Your journal (never a household member's). */
  journal: JournalEntry[]
  people: Person[]
  /** YYYY-MM-DD */
  today: string
  tomorrow: string
  myId: string | null
  onSaveRoutine(r: Routine): void
  onSaveJournal(e: JournalEntry): void
  onDeleteJournal(id: string): void
  onApply(r: ShutdownResult): void
  onClose(): void
}

/**
 * "Shut down": the evening routine, today in a line (the same journal entry
 * Today's card edits, mood included), what is left over, and tomorrow's three.
 * Routine ticks and the journal save as they always do; the leftovers' moves
 * and tomorrow's focus go to the planner through onApply, with one Undo.
 */
export function ShutdownSheet({
  tasks,
  projects,
  reviews,
  routines,
  journal,
  people,
  today,
  tomorrow,
  myId,
  onSaveRoutine,
  onSaveJournal,
  onDeleteJournal,
  onApply,
  onClose,
}: Props) {
  const live = useMemo(() => tasks.filter(t => !t.deletedAt), [tasks])
  const byId = useMemo(() => new Map(live.map(t => [t.id, t])), [live])
  const evening = routines.filter(r => r.when === 'evening' && !r.deletedAt && !r.archivedAt)
  const left = useMemo(() => leftovers(live, today, myId), [live, today, myId])
  const focusLeft = useMemo(() => new Set(left.filter(t => isFocusFor(t, today, myId)).map(t => t.id)), [left, today, myId])
  // what tomorrow already has (a second shut-down), then today's unfinished focus: "keep" is on by default
  const [initialPicks] = useState(() => {
    const planned = live.filter(t => OPEN_STATUSES.includes(t.status) && isFocusFor(t, tomorrow, myId)).map(t => t.id)
    const carried = leftovers(live, today, myId)
      .filter(t => isFocusFor(t, today, myId))
      .map(t => t.id)
    return [...new Set([...planned, ...carried])].slice(0, MAX_FOCUS)
  })
  const [moves, setMoves] = useState<Record<string, MoveTo>>({})
  const [picks, setPicks] = useState<string[]>(initialPicks)
  const [limit, setLimit] = useState(false)

  // moved past tomorrow, to the wishlist, or done: not tomorrow's focus
  const gone = new Set(Object.keys(moves).filter(id => moves[id] !== 'tomorrow'))
  const movedTomorrow = new Set(Object.keys(moves).filter(id => moves[id] === 'tomorrow'))
  const openPicks = picks.filter(id => !gone.has(id))
  const [y, m, d] = tomorrow.split('-').map(Number)
  // Next up and the week's 3 as they will stand at nine tomorrow
  const morning = new Date(y, m - 1, d, 9)
  const offered = focusCandidates({ tasks: live, projects, reviews, today: tomorrow, now: morning, myId, movedToday: movedTomorrow }).filter(
    c => !gone.has(c.task.id) && !picks.includes(c.task.id),
  )

  const setMove = (id: string, to: MoveTo | undefined) =>
    setMoves(cur => {
      const next = { ...cur }
      if (to) next[id] = to
      else delete next[id]
      return next
    })
  const add = (id: string) => {
    if (picks.includes(id)) return
    if (openPicks.length >= MAX_FOCUS) return setLimit(true)
    setPicks(p => [...p, id])
    setLimit(false)
  }
  const remove = (id: string) => {
    setPicks(p => p.filter(x => x !== id))
    setLimit(false)
  }

  const result: ShutdownResult = { moves: Object.keys(moves).map(id => ({ id, to: moves[id] })), tomorrowFocusIds: openPicks }
  const sameFocus = openPicks.length === initialPicks.length && openPicks.every(id => initialPicks.includes(id))
  const dirty = result.moves.length > 0 || !sameFocus

  return (
    // routine ticks and the journal are saved as they are made; only the choices below wait for Close the day
    <Modal onClose={onClose} className="modal narrow plan-sheet shutdown-sheet" closeOnBackdrop={!dirty}>
      <ModalHead title="Shut down" />
      <div className="modal-body">
        <section className="plan-section">
          <h3 className="plan-h">Evening routine</h3>
          {evening.length > 0 ? (
            <RoutineTicks routines={evening} today={today} onSave={onSaveRoutine} />
          ) : (
            <p className="plan-empty">No evening routine yet — add one from the Routines card on Today.</p>
          )}
        </section>

        <section className="plan-section">
          <h3 className="plan-h">Today in a line</h3>
          <JournalEditor
            key={today}
            entry={entryOn(journal, today)}
            date={today}
            people={people}
            rows={3}
            placeholder="One line about today…"
            onSave={onSaveJournal}
            onDelete={onDeleteJournal}
          />
        </section>

        <section className="plan-section">
          <div className="plan-section-head">
            <h3 className="plan-h">
              Left over <span className="plan-count">{left.length}</span>
            </h3>
            {left.length > 1 && (
              <button type="button" className="btn" onClick={() => setMoves(cur => ({ ...cur, ...Object.fromEntries(left.map(t => [t.id, 'tomorrow' as const])) }))}>
                Move all to tomorrow
              </button>
            )}
          </div>
          {left.length === 0 ? (
            <p className="plan-empty">Nothing left over — today is clear.</p>
          ) : (
            <ul className="plan-list">
              {left.map(t => (
                <li key={t.id} className="plan-row">
                  <div className="plan-row-main">
                    <span className="plan-task-title">{t.title || 'Untitled'}</span>
                    {focusLeft.has(t.id) && <span className="badge focus-badge">Today’s focus</span>}
                    <DueBadge task={t} />
                  </div>
                  <MoveChips title={t.title} value={moves[t.id]} options={LEFTOVER_MOVES} onChange={to => setMove(t.id, to)} />
                  {focusLeft.has(t.id) && !gone.has(t.id) && (
                    <label className="plan-keep">
                      <input type="checkbox" className="tcheck" checked={picks.includes(t.id)} onChange={() => (picks.includes(t.id) ? remove(t.id) : add(t.id))} />
                      Keep in tomorrow’s focus
                    </label>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <FocusPicker
          heading="Tomorrow’s focus"
          picks={openPicks.map(id => ({ id, title: byId.get(id)?.title || 'Untitled' }))}
          limit={limit}
          candidates={offered}
          groupLabel={TOMORROW_GROUPS}
          reasonOf={tonightReason}
          emptyHint="Up to three things for tomorrow, so the morning starts decided."
          onAdd={add}
          onRemove={remove}
        />
      </div>
      <footer className="modal-foot">
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => onApply(result)}>
          Close the day
        </button>
      </footer>
    </Modal>
  )
}
