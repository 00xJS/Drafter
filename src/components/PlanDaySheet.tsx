import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { CalendarEntry, CalendarEvent, MEAL_SLOT_META, Meal, MealSlot, OPEN_STATUSES, Place, Project, Recipe, Review, Task } from '../types'
import { MAX_FOCUS, focusCandidates, freeSlots } from '../focus'
import type { DayMove, DayPlanResult, FocusCandidate, FocusGroup } from '../focus'
import { focusTasks } from '../../shared/today.mjs'
import type { MealIdea } from '../../shared/weekplan.mjs'
import { compareTasks, dayOffset } from '../taskutils'
import { clock, dateKey, uid } from '../utils'
import { DueBadge } from './bits'
import { Modal, ModalHead } from './Modal'
import { openMealIdeas } from './MealIdeasCard'

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

const STEP_LABEL: Record<PlanStep, string> = { overdue: 'Overdue', focus: 'Focus', time: 'Time', meals: 'Meals' }
const MOVE_LABEL: Record<MoveTo, string> = { today: 'Today', tomorrow: 'Tomorrow', nextweek: 'Next week', wishlist: 'Wishlist', done: 'Done' }
const GROUP_ORDER: FocusGroup[] = ['carried', 'dueToday', 'weekTop', 'nextUp']
const TODAY_GROUPS: Record<FocusGroup, string> = { carried: 'Carried over', dueToday: 'Due today', weekTop: 'This week’s 3', nextUp: 'Next up' }
const OVERDUE_MOVES: readonly MoveTo[] = ['today', 'tomorrow', 'nextweek', 'wishlist', 'done']
const DURATIONS = [30, 60, 90] as const
const DEFAULT_MINUTES = 60
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

/** Each task's time block on `dayKey`: its earliest timed entry that day whose taskId names it. */
export function blocksOn(entries: readonly CalendarEntry[], dayKey: string): Map<string, CalendarEntry> {
  const out = new Map<string, CalendarEntry>()
  for (const e of entries) {
    if (!e.taskId || e.deletedAt || e.allDay || dateKey(e.start) !== dayKey) continue
    const cur = out.get(e.taskId)
    if (!cur || Date.parse(e.start) < Date.parse(cur.start)) out.set(e.taskId, e)
  }
  return out
}

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
  reasonOf = c => c.reason,
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
  /** The tasks the planner shows (Mine / Everyone applied). */
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
  /** For the Meals step; without all three it is never offered. */
  meals?: Meal[]
  recipes?: Recipe[]
  places?: Place[]
  onApply(r: PlanDayApply): void
  onClose(): void
}

/**
 * "Plan my day": what's overdue gets a new day, up to three things become
 * today's focus, each can have a block of time, and an empty lunch or dinner
 * can be decided. It writes nothing — Done hands the whole plan to the planner,
 * which applies it with one Undo. Done with nothing changed just closes.
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
  meals,
  recipes,
  places,
  onApply,
  onClose,
}: Props) {
  // the moment the sheet opened: slots re-rounded every render would move under the thumb
  const [at] = useState(now)
  const live = useMemo(() => tasks.filter(t => !t.deletedAt), [tasks])
  const byId = useMemo(() => new Map(live.map(t => [t.id, t])), [live])
  // the same set as Today's Overdue section
  const overdue = useMemo(
    () => live.filter(t => OPEN_STATUSES.includes(t.status) && !!t.dueAt && dayOffset(t.dueAt, at) < 0).sort(compareTasks),
    [live, at],
  )
  const focusNow = useMemo(() => focusTasks(live, today, myId), [live, today, myId])
  const [initialPicks] = useState(() => focusTasks(tasks, today, myId).filter(t => OPEN_STATUSES.includes(t.status)).map(t => t.id))
  const existing = useMemo(() => blocksOn(entries ?? [], today), [entries, today])
  const mealGroups = useMemo(
    () => (meals && recipes && places ? openMealIdeas([...meals, ...recipes, ...places, ...live], today, at) : []),
    [meals, recipes, places, live, today, at],
  )

  const [moves, setMoves] = useState<Record<string, MoveTo>>({})
  const [picks, setPicks] = useState<string[]>(initialPicks)
  const [created, setCreated] = useState<{ id: string; title: string }[]>([])
  const [draft, setDraft] = useState('')
  const [limit, setLimit] = useState(false)
  const [choices, setChoices] = useState<Record<string, BlockChoice>>({})
  const [timeSeen, setTimeSeen] = useState(initialStep === 'time')
  const [mealPick, setMealPick] = useState<Partial<Record<MealSlot, string>>>({})

  const steps: PlanStep[] = [...(overdue.length ? (['overdue'] as PlanStep[]) : []), 'focus', 'time', ...(mealGroups.length ? (['meals'] as PlanStep[]) : [])]
  const [asked, setAsked] = useState<PlanStep>(() => initialStep ?? steps[0])
  const step: PlanStep = steps.includes(asked) ? asked : 'focus'
  const index = steps.indexOf(step)
  const go = (s: PlanStep) => {
    setAsked(s)
    if (s === 'time') setTimeSeen(true)
  }

  const movedToday = new Set(Object.keys(moves).filter(id => moves[id] === 'today'))
  // moved to another day or off the list: not today's focus, whatever it was
  const gone = new Set(Object.keys(moves).filter(id => moves[id] !== 'today'))
  const openPicks = picks.filter(id => !gone.has(id))
  const titleOf = (id: string) => byId.get(id)?.title || created.find(n => n.id === id)?.title || 'Untitled'
  const offered = focusCandidates({ tasks: live, projects, reviews, today, now: at, myId, movedToday }).filter(c => !gone.has(c.task.id) && !picks.includes(c.task.id))

  const setMove = (id: string, to: MoveTo | undefined) =>
    setMoves(m => {
      const next = { ...m }
      if (to) next[id] = to
      else delete next[id]
      return next
    })
  const setAll = (to: MoveTo) => setMoves(m => ({ ...m, ...Object.fromEntries(overdue.map(t => [t.id, to])) }))

  const add = (id: string) => {
    if (picks.includes(id)) return
    if (openPicks.length >= MAX_FOCUS) return setLimit(true)
    setPicks(p => [...p, id])
    setLimit(false)
  }
  const remove = (id: string) => {
    setPicks(p => p.filter(x => x !== id))
    setCreated(c => c.filter(n => n.id !== id))
    setLimit(false)
  }
  const addNew = (e: FormEvent) => {
    e.preventDefault()
    const title = draft.trim().slice(0, 140)
    if (!title) return
    if (openPicks.length >= MAX_FOCUS) return setLimit(true)
    const id = uid()
    setCreated(c => [...c, { id, title }])
    setPicks(p => [...p, id])
    setDraft('')
    setLimit(false)
  }

  const choiceOf = (id: string): BlockChoice => choices[id] ?? { minutes: existing.has(id) ? 0 : DEFAULT_MINUTES, option: 0 }
  const setChoice = (id: string, c: BlockChoice) => setChoices(cs => ({ ...cs, [id]: c }))
  const planned = planBlocks(events, today, at, openPicks.map(id => ({ taskId: id, choice: choiceOf(id) })))

  const result: PlanDayApply = {
    moves: Object.keys(moves).map(id => ({ id, to: moves[id] })),
    focusIds: openPicks,
    // blocks are only proposed once the Time step has been seen: Done from Focus adds no time
    blocks: timeSeen
      ? openPicks.flatMap(id => {
          const b = planned.get(id)?.block
          return b ? [{ taskId: id, title: titleOf(id), start: b.start.toISOString(), end: b.end.toISOString() }] : []
        })
      : [],
    newTasks: created.filter(n => openPicks.includes(n.id)),
    meals: mealGroups.flatMap(g => {
      const idea = g.ideas.find(i => i.key === mealPick[g.slot])
      return idea ? [{ dayKey: today, slot: g.slot, idea }] : []
    }),
  }
  const sameFocus = openPicks.length === initialPicks.length && openPicks.every(id => initialPicks.includes(id))
  const dirty = result.moves.length > 0 || !sameFocus || result.blocks.length > 0 || (result.newTasks?.length ?? 0) > 0 || result.meals.length > 0
  const done = focusNow.filter(t => t.status === 'done')

  return (
    // a stray tap on the backdrop must not throw a half-made plan away; ✕ and Escape still close
    <Modal onClose={onClose} className="modal narrow plan-sheet" closeOnBackdrop={!dirty}>
      <ModalHead title="Plan my day" />
      <nav className="plan-steps" aria-label="Steps">
        <ol>
          {steps.map((s, i) => (
            <li key={s}>
              <button type="button" className={s === step ? 'plan-step on' : 'plan-step'} aria-current={s === step ? 'step' : undefined} onClick={() => go(s)}>
                <span className="plan-step-n" aria-hidden>
                  {i + 1}
                </span>
                {STEP_LABEL[s]}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className="modal-body">
        {step === 'overdue' && (
          <section className="plan-section">
            <p className="plan-lead">
              {overdue.length} overdue — give each a new day, or let it go. Anything left alone stays as it is.
            </p>
            <div className="plan-bulk">
              <button type="button" className="btn" onClick={() => setAll('today')}>
                All → today
              </button>
              <button type="button" className="btn" onClick={() => setAll('tomorrow')}>
                All → tomorrow
              </button>
            </div>
            <ul className="plan-list">
              {overdue.map(t => (
                <li key={t.id} className="plan-row">
                  <div className="plan-row-main">
                    <span className="plan-task-title">{t.title || 'Untitled'}</span>
                    <DueBadge task={t} />
                  </div>
                  <MoveChips title={t.title} value={moves[t.id]} options={OVERDUE_MOVES} onChange={to => setMove(t.id, to)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {step === 'focus' && (
          <FocusPicker
            heading="Today’s focus"
            picks={openPicks.map(id => ({ id, title: titleOf(id), isNew: created.some(n => n.id === id) }))}
            doneLine={done.length ? `Done already: ${done.map(t => t.title || 'Untitled').join(' · ')}` : undefined}
            limit={limit}
            candidates={offered}
            groupLabel={TODAY_GROUPS}
            emptyHint="Up to three things that would make today a good day."
            onAdd={add}
            onRemove={remove}
          >
            <form className="plan-new" onSubmit={addNew}>
              <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="+ New task for today" aria-label="New task for today" maxLength={140} />
              <button type="submit" className="btn" disabled={!draft.trim()}>
                Add
              </button>
            </form>
          </FocusPicker>
        )}

        {step === 'time' && (
          <section className="plan-section">
            {openPicks.length === 0 ? (
              <p className="plan-empty">Pick today’s focus first, then give each one some time.</p>
            ) : (
              <>
                <p className="plan-lead">Optional: a block of time for each, in the free stretches of your day.</p>
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
              </>
            )}
          </section>
        )}

        {step === 'meals' && (
          <section className="plan-section">
            <p className="plan-lead">Nothing planned yet. Pick one for later, or leave it.</p>
            {mealGroups.map(g => (
              <div key={g.slot} className="plan-group">
                <h4 className="plan-group-label">{MEAL_SLOT_META[g.slot].label}</h4>
                <ul className="plan-cands">
                  {g.ideas.map(idea => {
                    const on = mealPick[g.slot] === idea.key
                    return (
                      <li key={idea.key}>
                        <button
                          type="button"
                          className={on ? 'plan-cand on' : 'plan-cand'}
                          aria-pressed={on}
                          onClick={() => setMealPick(m => ({ ...m, [g.slot]: on ? undefined : idea.key }))}
                        >
                          <span className="plan-cand-plus" aria-hidden>
                            {on ? '✓' : '+'}
                          </span>
                          <span className="plan-cand-text">
                            <span className="plan-task-title">
                              {idea.kind === 'place' && <span aria-hidden>🥡 </span>}
                              {idea.title}
                            </span>
                            <span className="plan-cand-why">{idea.why}</span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>

      <footer className="modal-foot">
        {index > 0 && (
          <button type="button" className="btn" onClick={() => go(steps[index - 1])}>
            Back
          </button>
        )}
        <span className="spacer" />
        {index < steps.length - 1 && (
          <button type="button" className="btn" onClick={() => go(steps[index + 1])}>
            Next: {STEP_LABEL[steps[index + 1]]}
          </button>
        )}
        <button type="button" className="btn primary" onClick={() => (dirty ? onApply(result) : onClose())}>
          Done
        </button>
      </footer>
    </Modal>
  )
}
