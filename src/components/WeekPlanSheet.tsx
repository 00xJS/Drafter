import { useId, useState } from 'react'
import { weekPlanSummary } from '../../shared/weekplan.mjs'
import type { AcceptedPlan, DinnerItem, WeekPlan } from '../../shared/weekplan.mjs'
import { WeekPolish, WeekPolishInput, polishWeekPlan, weekPolishInput } from '../ai'
import { formatMoney } from '../bills'
import { mealId, nextSwap } from '../kitchen'
import { Meal, Person, Place, PlaceCategory, Recipe, Task } from '../types'
import { aiFailureKind } from './AskSheet'
import { MealSlotRow } from './MealSlotRow'
import { Modal, ModalHead } from './Modal'

// "Plan next week": the proposal from shared/weekplan.mjs as rows to tick —
// dinners, catch-ups, overdue work, bills, a Top 3. Nothing here writes. The
// ticked rows go back to the planner as one AcceptedPlan, which it applies with
// a single Undo; the ✨ polish only changes what is ticked here.

/** One night's dinner as the sheet holds it: a recipe, a place, or out with no place. */
export interface DinnerPick {
  recipeId?: string
  out?: boolean
  placeId?: string
  title: string
}

/** The move for an overdue task that sends it back to the wishlist instead of to a day. */
export const WISHLIST = 'wishlist'

export interface WeekPlanChoices {
  dinners: Record<string, { on: boolean; pick: DinnerPick; alt: number }>
  people: Record<string, { on: boolean; day: string; title: string }>
  /** `to` is a day of the target week, or WISHLIST. */
  overdue: Record<string, { on: boolean; to: string }>
  top3: Record<string, boolean>
}

/** Every row ticked as proposed — except a busy night, which starts unticked. */
export function initialChoices(plan: WeekPlan): WeekPlanChoices {
  return {
    dinners: Object.fromEntries(plan.dinners.map(d => [d.key, { on: !d.busy, pick: { recipeId: d.recipeId, title: d.title }, alt: 0 }])),
    people: Object.fromEntries(plan.people.map(p => [p.key, { on: true, day: p.dueDay, title: p.title }])),
    overdue: Object.fromEntries(plan.overdue.map(o => [o.key, { on: true, to: o.toDay }])),
    top3: Object.fromEntries(plan.top3.map(t => [t.key, true])),
  }
}

/**
 * What the ticked rows add up to. A row that was proposed ticked and is now
 * unticked was said no to: its key goes in `dismissed`, so the next proposal
 * for that week leaves it out. A busy night left unticked was never said yes
 * to, so it stays on offer.
 */
export function acceptedPlan(plan: WeekPlan, c: WeekPlanChoices): AcceptedPlan {
  const dismissed: string[] = []
  const dinners: AcceptedPlan['dinners'] = []
  for (const d of plan.dinners) {
    const x = c.dinners[d.key]
    if (x?.on && x.pick.title) {
      dinners.push({
        date: d.date,
        title: x.pick.title,
        ...(x.pick.recipeId ? { recipeId: x.pick.recipeId } : {}),
        ...(x.pick.out ? { out: true } : {}),
        ...(x.pick.placeId ? { placeId: x.pick.placeId } : {}),
      })
    } else if (!d.busy) dismissed.push(d.key)
  }
  const people: AcceptedPlan['people'] = []
  for (const p of plan.people) {
    const x = c.people[p.key]
    if (x?.on) people.push({ personId: p.personId, dueDay: x.day || p.dueDay, title: x.title.trim() || p.title })
    else dismissed.push(p.key)
  }
  const resched: AcceptedPlan['resched'] = []
  const wishlist: string[] = []
  for (const o of plan.overdue) {
    const x = c.overdue[o.key]
    if (!x?.on) dismissed.push(o.key)
    else if (x.to === WISHLIST) wishlist.push(o.taskId)
    else resched.push({ taskId: o.taskId, toDay: x.to || o.toDay })
  }
  const top3: string[] = []
  for (const t of plan.top3) {
    if (c.top3[t.key]) top3.push(t.title)
    else dismissed.push(t.key)
  }
  return { dinners, people, resched, wishlist, top3, dismissed }
}

/** How many things "Add N to next week" adds. */
export const acceptedCount = (a: AcceptedPlan) => a.dinners.length + a.people.length + a.resched.length + a.wishlist.length + a.top3.length

/** Where the rows said no to for a week are remembered, so its next proposal leaves them out. */
export const weekPlanDismissedKey = (weekKey: string) => `drafter:weekplan-dismissed:${weekKey}`

export function readWeekPlanDismissed(weekKey: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(weekPlanDismissedKey(weekKey)) ?? '[]')
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

/** Add to a week's dismissed rows (never replace them). */
export function rememberWeekPlanDismissed(weekKey: string, keys: readonly string[]): void {
  if (keys.length === 0) return
  try {
    const next = [...new Set([...readWeekPlanDismissed(weekKey), ...keys])].slice(-200)
    localStorage.setItem(weekPlanDismissedKey(weekKey), JSON.stringify(next))
  } catch {
    /* private mode: they come back next time, which is harmless */
  }
}

/** "Sun 20 Sep", read at local noon so no zone can move it a day. */
const dayLabel = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** A synthetic meal for MealSlotRow to show the pick; only its fields are read back. */
function asMeal(date: string, p: DinnerPick): Meal | undefined {
  if (!p.recipeId && !p.out) return undefined
  const stamp = '1970-01-01T00:00:00.000Z'
  return { kind: 'meal', id: mealId(date, 'dinner'), date, slot: 'dinner', title: p.title, recipeId: p.recipeId, out: p.out, placeId: p.placeId, createdAt: stamp, updatedAt: stamp }
}

type Polish = { status: 'idle' } | { status: 'busy' } | { status: 'done'; input: WeekPolishInput; result: WeekPolish } | { status: 'failed'; message: string }

interface Props {
  plan: WeekPlan
  recipes: Recipe[]
  places: Place[]
  people: Person[]
  /** For the optional ✨ polish: how often each recipe was cooked and when people were last seen. */
  meals: Meal[]
  tasks: Task[]
  /** "Pick…" is MealSlotRow's picker, with the Kitchen tab's "Somewhere new…" / "Something new…". */
  onCreatePlace(name: string, category: PlaceCategory): Place
  onCreateRecipe?(name: string): Recipe
  /** The ticked rows. The planner applies them with one Undo and closes the sheet. */
  onApply(a: AcceptedPlan): void
  onClose(): void
  /** The ✨ call; defaults to polishWeekPlan's one /api/ai request. */
  polish?(input: WeekPolishInput): Promise<WeekPolish>
  now?: Date
}

export function WeekPlanSheet({ plan, recipes, places, people, meals, tasks, onCreatePlace, onCreateRecipe, onApply, onClose, polish = polishWeekPlan, now }: Props) {
  const [c, setC] = useState(() => initialChoices(plan))
  const [picking, setPicking] = useState<string | null>(null)
  const [pol, setPol] = useState<Polish>({ status: 'idle' })
  const ids = useId()
  const recipeById = new Map(recipes.map(r => [r.id, r]))
  const accepted = acceptedPlan(plan, c)
  const n = acceptedCount(accepted)
  const summary = weekPlanSummary(plan)
  const days = plan.week.dayKeys

  const setDinner = (key: string, patch: Partial<WeekPlanChoices['dinners'][string]>) => setC(cur => ({ ...cur, dinners: { ...cur.dinners, [key]: { ...cur.dinners[key], ...patch } } }))
  const setPerson = (key: string, patch: Partial<WeekPlanChoices['people'][string]>) => setC(cur => ({ ...cur, people: { ...cur.people, [key]: { ...cur.people[key], ...patch } } }))
  const setOverdue = (key: string, patch: Partial<WeekPlanChoices['overdue'][string]>) => setC(cur => ({ ...cur, overdue: { ...cur.overdue, [key]: { ...cur.overdue[key], ...patch } } }))

  /** Swap cycles the night's own pick and its alternatives — never another night's — past any dish another ticked night has. */
  const cycleOf = (d: DinnerItem) => [d.recipeId, ...d.alternatives].filter(id => recipeById.has(id))
  const takenBy = (d: DinnerItem) =>
    new Set(plan.dinners.filter(o => o.key !== d.key && c.dinners[o.key]?.on).flatMap(o => (c.dinners[o.key].pick.recipeId ? [c.dinners[o.key].pick.recipeId!] : [])))
  const swapTo = (d: DinnerItem) => nextSwap(cycleOf(d), c.dinners[d.key].alt, takenBy(d))
  const swap = (d: DinnerItem) => {
    const cycle = cycleOf(d)
    const alt = swapTo(d)
    if (alt === null) return
    const r = recipeById.get(cycle[alt])!
    setDinner(d.key, { alt, on: true, pick: { recipeId: r.id, title: r.name } })
  }

  const runPolish = async () => {
    const input = weekPolishInput(plan, { recipes, people, meals, tasks, now: now ?? new Date() })
    setPol({ status: 'busy' })
    try {
      setPol({ status: 'done', input, result: await polish(input) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const kind = aiFailureKind(message)
      setPol({
        status: 'failed',
        message:
          kind === 'busy'
            ? 'The assistant is busy — try again in a minute.'
            : kind === 'unavailable'
              ? 'The assistant isn’t available here — the plan above works without it.'
              : `Couldn’t polish the plan: ${message}`,
      })
    }
  }
  /** The polish's recipe for a night, only ever one of that night's own candidates (ai.ts already checked). */
  const polishedDinner = (date: string): Recipe | null => {
    if (pol.status !== 'done') return null
    const ref = pol.result.dinners.find(x => x.date === date)?.recipeRef
    const id = ref ? pol.input.nights.find(x => x.date === date)?.candidates.find(x => x.ref === ref)?.id : undefined
    return (id && recipeById.get(id)) || null
  }
  const polishedIdea = (personId: string): string | null => {
    if (pol.status !== 'done') return null
    const ref = pol.input.people.find(p => p.id === personId)?.ref
    return pol.result.catchUps.find(x => x.personRef === ref)?.idea ?? null
  }
  const usePolishedDinners = () =>
    setC(cur => {
      const dinners = { ...cur.dinners }
      for (const d of plan.dinners) {
        const r = polishedDinner(d.date)
        if (r) dinners[d.key] = { ...dinners[d.key], on: true, pick: { recipeId: r.id, title: r.name } }
      }
      return { ...cur, dinners }
    })
  const polishedDinners = plan.dinners.filter(d => {
    const r = polishedDinner(d.date)
    return r && r.id !== c.dinners[d.key]?.pick.recipeId
  }).length

  const nothing = !summary

  return (
    <Modal onClose={onClose} className="modal week-plan-sheet">
      <ModalHead title="Plan next week" />
      <div className="modal-body">
        <p className="week-plan-sub">
          {dayLabel(days[0])} – {dayLabel(days[6])}
          {summary ? ` · ${summary}` : ''}
        </p>
        {nothing ? (
          <p className="empty">Nothing to plan: every dinner is set, nobody is due a catch-up and nothing is overdue.</p>
        ) : (
          <>
            {(plan.dinners.length > 0 || plan.people.length > 0) && (
              <div className="week-plan-polish">
                <button type="button" className="btn" onClick={runPolish} disabled={pol.status === 'busy'}>
                  {pol.status === 'busy' ? 'Thinking…' : '✨ Polish with the assistant'}
                </button>
                {pol.status === 'failed' && <small className="ask-note">{pol.message}</small>}
                {pol.status === 'done' && (
                  <>
                    {pol.result.note && <small className="week-plan-note">✨ {pol.result.note}</small>}
                    {polishedDinners > 0 && (
                      <button type="button" className="btn subtle" onClick={usePolishedDinners}>
                        Use its {polishedDinners} dinner pick{polishedDinners === 1 ? '' : 's'}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {plan.dinners.length > 0 && (
              <section className="week-plan-group" aria-labelledby={`${ids}-dinners`}>
                <h3 id={`${ids}-dinners`}>Dinners</h3>
                <ul className="week-plan-rows">
                  {plan.dinners.map(d => {
                    const x = c.dinners[d.key]
                    const proposed = x.pick.recipeId === d.recipeId && !x.pick.out
                    const suggestion = polishedDinner(d.date)
                    return (
                      <li key={d.key} className={x.on ? 'week-plan-row' : 'week-plan-row off'}>
                        <input
                          type="checkbox"
                          className="tcheck"
                          checked={x.on}
                          disabled={!x.pick.title}
                          onChange={() => setDinner(d.key, { on: !x.on })}
                          aria-label={`Dinner on ${dayLabel(d.date)}: ${x.pick.title || 'nothing picked'}`}
                        />
                        <div className="week-plan-main">
                          <span className="week-plan-title">
                            <span className="week-plan-day">{dayLabel(d.date)}</span> {x.pick.title || 'Nothing picked'}
                          </span>
                          <span className="week-plan-why">
                            {d.busy && <span className="week-plan-busy">Busy: {d.busy} · </span>}
                            {proposed ? d.why : x.pick.out ? 'Eating out' : 'Your pick'}
                          </span>
                          {suggestion && suggestion.id !== x.pick.recipeId && <span className="week-plan-ai">✨ The assistant would cook {suggestion.name}</span>}
                          <div className="week-plan-actions">
                            <button type="button" className="btn subtle" onClick={() => swap(d)} disabled={swapTo(d) === null}>
                              Swap
                            </button>
                            <button type="button" className="btn subtle" aria-expanded={picking === d.key} onClick={() => setPicking(p => (p === d.key ? null : d.key))}>
                              Pick…
                            </button>
                          </div>
                          {picking === d.key && (
                            <MealSlotRow
                              date={d.date}
                              slot="dinner"
                              meal={asMeal(d.date, x.pick)}
                              recipes={recipes}
                              places={places}
                              onSave={m => {
                                setDinner(d.key, { on: true, pick: { recipeId: m.recipeId, out: m.out, placeId: m.placeId, title: m.title } })
                                setPicking(null)
                              }}
                              onClear={() => {
                                setDinner(d.key, { on: false, pick: { title: '' } })
                                setPicking(null)
                              }}
                              onCreatePlace={onCreatePlace}
                              onCreateRecipe={onCreateRecipe}
                            />
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {plan.people.length > 0 && (
              <section className="week-plan-group" aria-labelledby={`${ids}-people`}>
                <h3 id={`${ids}-people`}>Catch-ups</h3>
                <ul className="week-plan-rows">
                  {plan.people.map(p => {
                    const x = c.people[p.key]
                    const idea = polishedIdea(p.personId)
                    return (
                      <li key={p.key} className={x.on ? 'week-plan-row' : 'week-plan-row off'}>
                        <input type="checkbox" className="tcheck" checked={x.on} onChange={() => setPerson(p.key, { on: !x.on })} aria-label={x.title} />
                        <div className="week-plan-main">
                          <span className="week-plan-title">{x.title}</span>
                          <span className="week-plan-why">{p.why}</span>
                          {idea && idea !== x.title && (
                            <span className="week-plan-ai">
                              ✨ {idea}{' '}
                              <button type="button" className="btn subtle" onClick={() => setPerson(p.key, { title: idea, on: true })}>
                                Use this
                              </button>
                            </span>
                          )}
                          <div className="week-plan-actions">
                            <select value={x.day} onChange={e => setPerson(p.key, { day: e.target.value, on: true })} aria-label={`Day for “${x.title}”`}>
                              {days.map(day => (
                                <option key={day} value={day}>
                                  {dayLabel(day)}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {plan.overdue.length > 0 && (
              <section className="week-plan-group" aria-labelledby={`${ids}-overdue`}>
                <h3 id={`${ids}-overdue`}>Overdue</h3>
                <ul className="week-plan-rows">
                  {plan.overdue.map(o => {
                    const x = c.overdue[o.key]
                    return (
                      <li key={o.key} className={x.on ? 'week-plan-row' : 'week-plan-row off'}>
                        <input type="checkbox" className="tcheck" checked={x.on} onChange={() => setOverdue(o.key, { on: !x.on })} aria-label={`Move “${o.title}”`} />
                        <div className="week-plan-main">
                          <span className="week-plan-title">{o.title}</span>
                          <span className="week-plan-why">{o.why}</span>
                          <div className="week-plan-actions">
                            <select value={x.to} onChange={e => setOverdue(o.key, { to: e.target.value, on: true })} aria-label={`Where “${o.title}” goes`}>
                              {days.map(day => (
                                <option key={day} value={day}>
                                  {dayLabel(day)}
                                </option>
                              ))}
                              <option value={WISHLIST}>Back to wishlist</option>
                            </select>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {plan.bills.length > 0 && (
              <section className="week-plan-group" aria-labelledby={`${ids}-bills`}>
                <h3 id={`${ids}-bills`}>Bills due</h3>
                <ul className="week-plan-rows">
                  {plan.bills.map(b => (
                    <li key={b.key} className="week-plan-row readonly">
                      <span className="week-plan-glyph" aria-hidden>
                        🧾
                      </span>
                      <div className="week-plan-main">
                        <span className="week-plan-title">{b.title}</span>
                        <span className="week-plan-why">
                          Due {dayLabel(b.dueDay)}
                          {b.amount !== null ? ` · ${formatMoney(b.amount)}` : ''}
                          {b.autopay ? ' · autopay' : ' · pay it yourself'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {plan.top3.length > 0 && (
              <section className="week-plan-group" aria-labelledby={`${ids}-top`}>
                <h3 id={`${ids}-top`}>Top 3</h3>
                <p className="week-plan-why">Saved as last week’s “Top 3 for next week”, which Today shows as this week’s 3.</p>
                <ul className="week-plan-rows">
                  {plan.top3.map(t => (
                    <li key={t.key} className={c.top3[t.key] ? 'week-plan-row' : 'week-plan-row off'}>
                      <input
                        type="checkbox"
                        className="tcheck"
                        checked={!!c.top3[t.key]}
                        onChange={() => setC(cur => ({ ...cur, top3: { ...cur.top3, [t.key]: !cur.top3[t.key] } }))}
                        aria-label={t.title}
                      />
                      <div className="week-plan-main">
                        <span className="week-plan-title">{t.title}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      <footer className="modal-foot">
        <small className="week-plan-note week-plan-foot-note">Nothing is added until you press Add.</small>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          {nothing ? 'Close' : 'Cancel'}
        </button>
        {!nothing && (
          <button className="btn primary" disabled={n === 0} onClick={() => onApply(accepted)}>
            Add {n} to next week
          </button>
        )}
      </footer>
    </Modal>
  )
}
