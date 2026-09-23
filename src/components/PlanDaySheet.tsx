import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { OPEN_STATUSES } from '../types'
import type { CalendarEntry, CalendarEvent, Meal, MealSlot, Place, Project, Recipe, Review, Task } from '../types'
import { MAX_FOCUS, blocksOn, focusCandidates, freeSlots } from '../focus'
import type { DayMove, DayPlanResult, FocusCandidate, FocusGroup } from '../focus'
import { focusTasks } from '../../shared/today.mts'
import type { MealIdea } from '../../shared/weekplan.mts'
import { clock } from '../utils'
import { Modal, ModalHead } from './Modal'

export type PlanStep = 'overdue' | 'focus' | 'time' | 'meals'
export type MoveTo = DayMove['to']

/** A meal idea picked in the Meals step: the planner plans it (mealFromIdea) with the rest of the plan. */
export interface MealChoice {
  dayKey: string
  slot: MealSlot
  idea: MealIdea
}

/** What Plan my day hands the planner: planDayWrites' input, plus any meal ideas picked. */
export interface PlanDayApply extends DayPlanResult {
  meals: MealChoice[]
}

const MOVE_LABEL: Record<MoveTo, string> = { today: 'Today', tomorrow: 'Tomorrow', nextweek: 'Next week', wishlist: 'Wishlist', done: 'Done' }
const GROUP_ORDER: FocusGroup[] = ['carried', 'dueToday', 'weekTop', 'nextUp']
const TODAY_GROUPS: Record<FocusGroup, string> = { carried: 'Carried over', dueToday: 'Due today', weekTop: 'This week’s 3', nextUp: 'Next up' }
const DURATIONS = [30, 60, 90] as const
const MINUTE_MS = 60_000

const durationLabel = (m: number) => (m === 30 ? '30 min' : m === 60 ? '1 hour' : m === 90 ? '1½ hours' : `${m} min`)
const spanLabel = (s: { start: Date | string; end: Date | string }) =>
  `${clock(new Date(s.start).toISOString())}–${clock(new Date(s.end).toISOString())}`

/** The next :00 or :30 at or after an instant, in local time. */
function nextHalfHour(ms: number): number {
  const d = new Date(ms)
  if (d.getMinutes() % 30 === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) return ms
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60)
  return d.getTime()
}

/**
 * Where a block of `minutes` could go: the first place it fits, then the next
 * ones after it (each starting on a :00 or :30), up to `count`, in time order.
 * The first is the suggestion; the others are "or later".
 */
export function blockOptions(slots: { start: Date; end: Date }[], minutes: number, count = 3): { start: Date; end: Date }[] {
  const ms = minutes * MINUTE_MS
  const out: { start: Date; end: Date }[] = []
  if (!(ms > 0)) return out
  for (const s of slots) {
    for (let at = s.start.getTime(); out.length < count && at + ms <= s.end.getTime(); at = nextHalfHour(at + ms)) {
      out.push({ start: new Date(at), end: new Date(at + ms) })
    }
    if (out.length >= count) break
  }
  return out
}

/** How long a pick's block is (0: no new block) and which of its options it takes. */
export interface BlockChoice {
  minutes: number
  option: number
}

/**
 * Each pick's options and chosen block, in the order picked: a pick's options
 * are the free time left once the picks before it have their blocks, so two
 * picks never land on the same hour.
 */
export function planBlocks(
  events: CalendarEvent[],
  dayKey: string,
  now: Date,
  picks: { taskId: string; choice: BlockChoice }[],
): Map<string, { options: { start: Date; end: Date }[]; block: { start: Date; end: Date } | null }> {
  const taken: CalendarEvent[] = []
  const out = new Map<string, { options: { start: Date; end: Date }[]; block: { start: Date; end: Date } | null }>()
  for (const p of picks) {
    if (!(p.choice.minutes > 0)) {
      out.set(p.taskId, { options: [], block: null })
      continue
    }
    const options = blockOptions(freeSlots([...events, ...taken], dayKey, now), p.choice.minutes)
    const block = options[Math.min(Math.max(0, p.choice.option), options.length - 1)] ?? null
    if (block) taken.push({ id: `block:${p.taskId}`, sourceId: 'plan', title: '', start: block.start.toISOString(), end: block.end.toISOString(), allDay: false })
    out.set(p.taskId, { options, block })
  }
  return out
}

// blocksOn lives in focus.ts, so Today can read a task's block without loading
// this sheet's chunk; re-exported for existing callers.
export { blocksOn } from '../focus'

/** One row's move: a pill per destination, pressed again to leave the task where it is. */
export function MoveChips({ title, value, options, onChange }: { title: string; value?: MoveTo; options: readonly MoveTo[]; onChange(to: MoveTo | undefined): void }) {
  return (
    <div className="segmented plan-moves" role="group" aria-label={`Move “${title || 'Untitled'}” to`}>
      {options.map(to => (
        <button key={to} type="button" className={value === to ? 'seg on' : 'seg'} aria-pressed={value === to} onClick={() => onChange(value === to ? undefined : to)}>
          {MOVE_LABEL[to]}
        </button>
      ))}
    </div>
  )
}

/** A candidate's own reason, when the caller words none. Named out here: the React Compiler cannot compile a component whose default is a function written in place. */
const ownReason = (c: FocusCandidate) => c.reason

/**
 * The three picks on top, then what else is asking for the day in its groups.
 * Plan my day uses it for today and Shut down for tomorrow; a fourth pick is
 * refused with a line saying so, never by silently dropping one.
 */
export function FocusPicker({
  heading,
  picks,
  doneLine,
  limit,
  candidates,
  groupLabel,
  reasonOf = ownReason,
  emptyHint,
  onAdd,
  onRemove,
  children,
}: {
  heading: string
  picks: { id: string; title: string; isNew?: boolean }[]
  doneLine?: string
  limit: boolean
  candidates: FocusCandidate[]
  groupLabel: Record<FocusGroup, string>
  reasonOf?(c: FocusCandidate): string
  emptyHint: string
  onAdd(id: string): void
  onRemove(id: string): void
  /** Between the picks and the candidates: Plan my day's "+ New task for today". */
  children?: ReactNode
}) {
  const where = heading.toLowerCase()
  const grouped = GROUP_ORDER.map(group => ({ group, list: candidates.filter(c => c.group === group) })).filter(g => g.list.length > 0)
  return (
    <section className="plan-section">
      <h3 className="plan-h">
        {heading}{' '}
        <span className="plan-count">
          {picks.length} of {MAX_FOCUS}
        </span>
      </h3>
      {picks.length === 0 ? (
        <p className="plan-empty">{emptyHint}</p>
      ) : (
        <ol className="plan-picks">
          {picks.map(p => (
            <li key={p.id} className="plan-pick">
              <span className="plan-task-title">{p.title}</span>
              {p.isNew && <span className="badge plan-new-badge">New</span>}
              <button type="button" className="btn subtle plan-remove" aria-label={`Remove “${p.title}” from ${where}`} onClick={() => onRemove(p.id)}>
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
      {doneLine && <p className="plan-done-line">{doneLine}</p>}
      <p className="plan-limit" role="status">
        {limit ? 'Three is the limit — swap one.' : ''}
      </p>
      {children}
      {grouped.map(({ group, list }) => (
        <div key={group} className="plan-group">
          <h4 className="plan-group-label">{groupLabel[group]}</h4>
          <ul className="plan-cands">
            {list.map(c => {
              const title = c.task.title || 'Untitled'
              const why = reasonOf(c)
              return (
                <li key={c.task.id}>
                  <button type="button" className="plan-cand" aria-label={`${title} — ${why}. Add to ${where}`} onClick={() => onAdd(c.task.id)}>
                    <span className="plan-cand-plus" aria-hidden>
                      +
                    </span>
                    <span className="plan-cand-text">
                      <span className="plan-task-title">{title}</span>
                      <span className="plan-cand-why">{why}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}

interface Props {
  /** The tasks the planner shows. */
  tasks: Task[]
  projects: Project[]
  reviews: Review[]
  /** Everything on the calendar, feeds and our own entries alike (the planner's allEvents): free time is what none of it covers. */
  events: CalendarEvent[]
  /** Our own entries, for the blocks a task already has today. */
  entries?: CalendarEntry[]
  /** YYYY-MM-DD */
  today: string
  now: Date
  myId: string | null
  /** Where to open: Edit on the focus card opens at 'focus'. A step with nothing in it falls back to Focus. */
  initialStep?: PlanStep
  /** Mirroring to Google or Outlook is on: blocks will show there as busy. */
  mirroring?: boolean
  /** For the Meals step; without all three it is never offered. Kept so an
   *  older caller still type-checks — meals are planned on Home / Kitchen. */
  meals?: Meal[]
  recipes?: Recipe[]
  places?: Place[]
  /** Open the real new-task sheet, due today, instead of a second composer. */
  onNewForToday?(): void
  onApply(r: PlanDayApply): void
  onClose(): void
}

/**
 * "Plan my day": pick today’s three on Home. Overdue, meals and a blank
 * capture already live on the day — this sheet only names the focus and,
 * optionally, a block of time. It writes nothing until Done, which the
 * planner applies with one Undo. Done with nothing changed just closes.
 */
export function PlanDaySheet({
  tasks,
  projects,
  reviews,
  events,
  entries,
  today,
  now,
  myId,
  initialStep,
  mirroring = false,
  onNewForToday,
  onApply,
  onClose,
}: Props) {
  // the moment the sheet opened: slots re-rounded every render would move under the thumb
  const [at] = useState(now)
  const live = useMemo(() => tasks.filter(t => !t.deletedAt), [tasks])
  const byId = useMemo(() => new Map(live.map(t => [t.id, t])), [live])
  const focusNow = useMemo(() => focusTasks(live, today, myId), [live, today, myId])
  const [initialPicks] = useState(() => focusTasks(tasks, today, myId).filter(t => OPEN_STATUSES.includes(t.status)).map(t => t.id))
  const existing = useMemo(() => blocksOn(entries ?? [], today), [entries, today])

  const [picks, setPicks] = useState<string[]>(initialPicks)
  const [limit, setLimit] = useState(false)
  const [choices, setChoices] = useState<Record<string, BlockChoice>>({})

  const openPicks = picks
  const titleOf = (id: string) => byId.get(id)?.title || 'Untitled'
  const offered = focusCandidates({ tasks: live, projects, reviews, today, now: at, myId }).filter(c => !picks.includes(c.task.id))

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

  const choiceOf = (id: string): BlockChoice => choices[id] ?? { minutes: 0, option: 0 }
  const setChoice = (id: string, c: BlockChoice) => setChoices(cs => ({ ...cs, [id]: c }))
  const planned = planBlocks(events, today, at, openPicks.map(id => ({ taskId: id, choice: choiceOf(id) })))

  const result: PlanDayApply = {
    moves: [],
    focusIds: openPicks,
    blocks: openPicks.flatMap(id => {
      const b = planned.get(id)?.block
      return b ? [{ taskId: id, title: titleOf(id), start: b.start.toISOString(), end: b.end.toISOString() }] : []
    }),
    newTasks: [],
    meals: [],
  }
  const sameFocus = openPicks.length === initialPicks.length && openPicks.every(id => initialPicks.includes(id))
  const dirty = !sameFocus || result.blocks.length > 0
  const done = focusNow.filter(t => t.status === 'done')
  void initialStep

  return (
    <Modal onClose={onClose} className="modal narrow plan-sheet" closeOnBackdrop={!dirty}>
      <ModalHead title="Plan my day" variant="compose">
        <button type="button" className="btn primary" onClick={() => (dirty ? onApply(result) : onClose())}>
          Done
        </button>
      </ModalHead>

      <div className="modal-body">
        <p className="plan-lead">Home is the day. Pick up to three things that would make today a good day. Overdue and meals stay on Home.</p>
        <FocusPicker
          heading="Today’s focus"
          picks={openPicks.map(id => ({ id, title: titleOf(id) }))}
          doneLine={done.length ? `Done already: ${done.map(t => t.title || 'Untitled').join(' · ')}` : undefined}
          limit={limit}
          candidates={offered}
          groupLabel={TODAY_GROUPS}
          emptyHint="Up to three things that would make today a good day."
          onAdd={add}
          onRemove={remove}
        >
          {onNewForToday && (
            <button type="button" className="btn subtle editor-more" onClick={onNewForToday}>
              + New task for today
            </button>
          )}
        </FocusPicker>

        {openPicks.length > 0 && (
          <section className="plan-section">
            <h3 className="plan-h">Time</h3>
            <p className="plan-lead">Optional: a block in the free stretches of the day.</p>
            {mirroring && <p className="plan-hint">Blocks show as busy on your connected calendars.</p>}
            <ul className="plan-list">
              {openPicks.map(id => {
                const title = titleOf(id)
                const choice = choiceOf(id)
                const p = planned.get(id)
                const had = existing.get(id)
                return (
                  <li key={id} className="plan-row">
                    <span className="plan-task-title">{title}</span>
                    <div className="segmented plan-durations" role="group" aria-label={`How long for “${title}”`}>
                      {DURATIONS.map(m => (
                        <button key={m} type="button" className={choice.minutes === m ? 'seg on' : 'seg'} aria-pressed={choice.minutes === m} onClick={() => setChoice(id, { minutes: m, option: 0 })}>
                          {durationLabel(m)}
                        </button>
                      ))}
                      <button type="button" className={choice.minutes === 0 ? 'seg on' : 'seg'} aria-pressed={choice.minutes === 0} onClick={() => setChoice(id, { minutes: 0, option: 0 })}>
                        {had ? 'Keep as is' : 'No block'}
                      </button>
                    </div>
                    {choice.minutes > 0 &&
                      (p && p.options.length > 0 ? (
                        <div className="segmented plan-options" role="group" aria-label={`When for “${title}”`}>
                          {p.options.map((o, i) => {
                            const on = p.block?.start.getTime() === o.start.getTime()
                            return (
                              <button key={o.start.getTime()} type="button" className={on ? 'seg on' : 'seg'} aria-pressed={on} onClick={() => setChoice(id, { minutes: choice.minutes, option: i })}>
                                {spanLabel(o)}
                              </button>
                            )
                          })}
                        </div>
                      ) : (
                        <p className="plan-empty">No free {durationLabel(choice.minutes)} left today.</p>
                      ))}
                    {had && (
                      <p className="plan-hint">
                        Already blocked {spanLabel(had)}
                        {choice.minutes > 0 ? ' — this adds another' : ''}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  )
}
