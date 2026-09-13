import { useId, useMemo, useState } from 'react'
import { mealHistory, mealIdeasFor, proposeWeek, targetWeek } from '../../shared/weekplan.mjs'
import type { MealHistory } from '../../shared/weekplan.mjs'
import { weekDayKeys } from '../../shared/weeks.mjs'
import { MealAssist, MealAssistInput, MealSuggestion, mealAssistInput, suggestMeals } from '../ai'
import { cookedIndex, visitIndex, daysAgo, daysBetween, mealId, mealLabel, mealRecipeIds, nextSwap, recipeByName } from '../kitchen'
import { CalendarEvent, MEAL_SLOTS, MEAL_SLOT_META, Meal, MealSlot, Place, PlaceCategory, Recipe, Task } from '../types'
import { dateKey } from '../utils'
import { aiFailureKind } from './AskSheet'
import { MealSlotRow } from './MealSlotRow'
import { Modal, ModalHead } from './Modal'

// "Plan this week's meals" on the Kitchen tab: a pick for every empty dinner
// (and lunch, when asked) from the kitchen's own ranking in shared/weekplan.mjs,
// each with Swap and Pick…, plus "✨ Ask for ideas" when deciding is hard.
// Nothing is planned until "Plan N meals" — then every meal goes through the
// Kitchen's own save path in one go, with an Undo.

/** What a slot will be: a recipe, a place you eat at, out with no place, or a dish that is not a recipe yet. */
export interface SlotChoice {
  kind: 'recipe' | 'place' | 'out' | 'new'
  /** The recipe's or the place's id. */
  id?: string
  title: string
  why?: string
  /** From the ✨ assistant rather than the ranking. */
  ai?: boolean
}

export interface MealPlanRow {
  /** `${date}|${slot}` */
  key: string
  date: string
  slot: MealSlot
  choice: SlotChoice | null
  /** What Swap cycles through: the first pick, then its alternatives. */
  options: SlotChoice[]
  /** The event across the dinner hour, when there is one: the row starts unticked. */
  busy: string | null
}

export interface MealPick {
  date: string
  slot: MealSlot
  choice: SlotChoice
}

const NEW_WHY = 'Something new: saved, never cooked'
const ALTERNATIVES = 3
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The ranking's reason, told from today whichever week is being planned. */
function cookedWhy(h: MealHistory['recipes'][number] | undefined, todayKey: string): string {
  if (!h || h.timesCooked === 0 || !h.lastCooked) return NEW_WHY
  const last = daysAgo(daysBetween(h.lastCooked, todayKey))
  return h.cookCount > 0 ? `Cooked ${h.cookCount}× in six months · last ${last}` : `Last cooked ${last}`
}

type Row = Record<string, unknown>
const live = (items: readonly unknown[], kind: string) => items.filter((i): i is Row => !!i && typeof i === 'object' && (i as Row).kind === kind && !(i as Row).deletedAt)

/**
 * The proposal for a week's empty slots from today on. Dinners are
 * proposeWeek's: favourites not cooked in a fortnight, one never-cooked recipe,
 * no repeats, a busy evening flagged. It plans "next week" from today, so for
 * any other week it is asked as of that week's Sunday; nights it could not fill
 * take the rest of the never-cooked recipes. Lunches, when included, are
 * mealIdeasFor's for each day — never something already picked that week.
 */
export function proposeMealWeek(o: {
  items: readonly unknown[]
  events?: readonly CalendarEvent[]
  weekStart: string
  todayKey: string
  lunches: boolean
  now: Date
  tz?: string
}): MealPlanRow[] {
  const week = weekDayKeys(o.weekStart)
  const days = week.filter(d => d >= o.todayKey)
  if (days.length === 0) return []
  const meals = live(o.items, 'meal') as unknown as Meal[]
  const recipes = live(o.items, 'recipe') as unknown as Recipe[]
  const filled = new Set(meals.map(m => `${m.date}|${m.slot}`))
  const anchor = targetWeek(o.todayKey)?.startKey === week[0] ? o.todayKey : week[0]
  const plan = proposeWeek(o.items, { todayKey: anchor, tz: o.tz, now: o.now, events: o.events ?? [], dismissed: week.filter(d => d < o.todayKey).map(d => `dinner:${d}`) })
  const history = new Map(mealHistory(o.items, { dayKey: o.todayKey, now: o.now, tz: o.tz }).recipes.map(r => [r.id, r]))
  const byId = new Map(recipes.map(r => [r.id, r]))
  const recipeChoice = (id: string, why?: string): SlotChoice | null => {
    const r = byId.get(id)
    return r ? { kind: 'recipe', id, title: r.name, why: why ?? cookedWhy(history.get(id), o.todayKey) } : null
  }
  const used = new Set<string>()
  const rows: MealPlanRow[] = []

  const proposed = new Map((plan?.dinners ?? []).map(d => [d.date, d]))
  for (const d of days) {
    if (filled.has(`${d}|dinner`)) continue
    const item = proposed.get(d)
    const choice = item ? recipeChoice(item.recipeId, item.isNew ? NEW_WHY : undefined) : null
    if (choice) used.add(`recipe:${choice.id}`)
    const alts = (item?.alternatives ?? []).map(id => recipeChoice(id)).filter((x): x is SlotChoice => !!x)
    rows.push({ key: `${d}|dinner`, date: d, slot: 'dinner', choice, options: choice ? [choice, ...alts] : alts, busy: item?.busy ?? null })
  }
  // the ranking offers one never-cooked recipe a week and a young kitchen has
  // little else, so a night it could not fill takes the next never-cooked one
  // a recipe that has been a side is not "never cooked" either
  const cooked = new Set(meals.flatMap(mealRecipeIds))
  const fresh = recipes
    .filter(r => !cooked.has(r.id))
    .sort((a, b) => cmp(b.createdAt ?? '', a.createdAt ?? '') || cmp(a.name, b.name) || cmp(a.id, b.id))
    .map((r): SlotChoice => ({ kind: 'recipe', id: r.id, title: r.name, why: NEW_WHY }))
  for (const row of rows) {
    if (row.choice) continue
    const next = fresh.find(c => !used.has(`recipe:${c.id}`))
    if (!next) break
    row.choice = next
    used.add(`recipe:${next.id}`)
  }
  // and Swap has somewhere to go: the never-cooked ones left over, never another night's pick
  const spare = fresh.filter(c => !used.has(`recipe:${c.id}`))
  const unique = (cs: SlotChoice[]) => cs.filter((c, i) => cs.findIndex(x => x.kind === c.kind && x.id === c.id) === i)
  for (const row of rows) row.options = unique([...(row.choice ? [row.choice] : []), ...row.options, ...spare]).slice(0, ALTERNATIVES + 1)

  if (o.lunches) {
    for (const d of days) {
      if (filled.has(`${d}|lunch`)) continue
      // what the week already has is dismissed for the day, so the ideas reach further down the list
      const dismissed = [...used].map(k => `idea:${d}:lunch:${k}`)
      const ideas = (mealIdeasFor(o.items, { dayKey: d, slots: ['lunch'], now: o.now, tz: o.tz, dismissed })[0]?.ideas ?? []).map(
        (i): SlotChoice => ({ kind: i.kind, id: i.id, title: i.title, why: i.why }),
      )
      const choice = ideas[0] ?? null
      if (choice) used.add(`${choice.kind}:${choice.id}`)
      rows.push({ key: `${d}|lunch`, date: d, slot: 'lunch', choice, options: ideas.slice(0, ALTERNATIVES + 1), busy: null })
    }
  }
  return rows.sort((a, b) => cmp(a.date, b.date) || MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot))
}

/** The assistant's suggestion as a choice, through the references it was shown — or nothing. */
export function choiceFromSuggestion(s: MealSuggestion, ids: Record<string, { kind: 'recipe' | 'place'; id: string }>, recipes: Recipe[], places: Place[]): SlotChoice | null {
  const why = s.why || undefined
  if (s.recipeRef) {
    const ref = ids[s.recipeRef]
    const r = ref?.kind === 'recipe' ? recipes.find(x => x.id === ref.id && !x.deletedAt) : undefined
    return r ? { kind: 'recipe', id: r.id, title: r.name, why, ai: true } : null
  }
  if (s.placeRef) {
    const ref = ids[s.placeRef]
    const p = ref?.kind === 'place' ? places.find(x => x.id === ref.id && !x.deletedAt) : undefined
    return p ? { kind: 'place', id: p.id, title: p.name, why, ai: true } : null
  }
  return s.newDish ? { kind: 'new', title: s.newDish, why, ai: true } : null
}

/**
 * The meals the accepted picks become. A slot planned meanwhile (another
 * device, the calendar) is never overwritten; a pick whose record has gone is
 * skipped; a new dish reuses a recipe of the same name, or becomes a recipe
 * stub with just its name, like the picker's "Something new…".
 */
export function mealsForPicks(
  picks: readonly MealPick[],
  d: { recipes: Recipe[]; places: Place[]; meals: Meal[]; createRecipe(name: string): Recipe; now: Date },
): { meals: Meal[]; created: Recipe[] } {
  const stamp = d.now.toISOString()
  const taken = new Set(d.meals.filter(m => !m.deletedAt).map(m => `${m.date}|${m.slot}`))
  const known = d.recipes.filter(r => !r.deletedAt)
  const created: Recipe[] = []
  const out: Meal[] = []
  for (const { date, slot, choice } of picks) {
    if (taken.has(`${date}|${slot}`)) continue
    let fields: Pick<Meal, 'recipeId' | 'out' | 'placeId' | 'title'> | null = null
    if (choice.kind === 'recipe') {
      const r = known.find(x => x.id === choice.id)
      if (r) fields = { recipeId: r.id, title: r.name }
    } else if (choice.kind === 'place') {
      const p = d.places.find(x => x.id === choice.id && !x.deletedAt)
      if (p) fields = { out: true, placeId: p.id, title: p.name }
    } else if (choice.kind === 'out') {
      fields = { out: true, title: choice.title || 'Eating out' }
    } else if (choice.title.trim()) {
      let r = recipeByName(choice.title, known)
      if (!r) {
        r = d.createRecipe(choice.title.trim())
        known.push(r)
        created.push(r)
      }
      fields = { recipeId: r.id, title: r.name }
    }
    if (!fields) continue
    taken.add(`${date}|${slot}`)
    out.push({ kind: 'meal', id: mealId(date, slot), date, slot, ...fields, createdAt: stamp, updatedAt: stamp })
  }
  return { meals: out, created }
}

const sameChoice = (a: SlotChoice | null, b: SlotChoice | null) => !!a && !!b && a.kind === b.kind && (a.id ?? a.title) === (b.id ?? b.title)

/** "Sun 20 Sep", read at local noon so no zone can move it a day. */
const dayLabel = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** A synthetic meal for MealSlotRow to show the pick; only its fields are read back. */
function asMeal(date: string, slot: MealSlot, c: SlotChoice | null): Meal | undefined {
  if (!c || c.kind === 'new') return undefined
  const stamp = '1970-01-01T00:00:00.000Z'
  const base = { kind: 'meal' as const, id: mealId(date, slot), date, slot, title: c.title, createdAt: stamp, updatedAt: stamp }
  if (c.kind === 'recipe') return { ...base, recipeId: c.id }
  return { ...base, out: true, ...(c.kind === 'place' ? { placeId: c.id } : {}) }
}

interface RowState extends MealPlanRow {
  on: boolean
  /** Which of `options` Swap is on. */
  alt: number
}
const toState = (r: MealPlanRow): RowState => ({ ...r, on: !!r.choice && !r.busy, alt: 0 })

type Assist = { status: 'idle' } | { status: 'busy' } | { status: 'done'; ideas: Record<string, SlotChoice>; note: string } | { status: 'failed'; message: string }

interface Props {
  week: { key: string; start: Date; label: string }
  /** Everything the kitchen's history reads: recipes, meals and places, and — when the planner has them — tasks and your own events. */
  items: readonly unknown[]
  /** Subscribed calendars' events, so a busy evening is flagged. */
  events?: readonly CalendarEvent[]
  recipes: Recipe[]
  places: Place[]
  /** Live meals, for what is already planned. */
  meals: Meal[]
  onCreatePlace(name: string, category: PlaceCategory): Place
  onCreateRecipe(name: string): Recipe
  /** Plan the picks through the Kitchen's save path. Returns how many were planned and their Undo, or null when none could be. */
  onApply(picks: MealPick[]): { count: number; undo(): void } | null
  /** When given, the confirmation and its Undo go to the planner's toast and the sheet closes; otherwise they stay in the sheet. */
  onToast?(msg: string, undo?: () => void): void
  onClose(): void
  /** The ✨ call; defaults to suggestMeals' one /api/ai request. */
  suggest?(input: MealAssistInput): Promise<MealAssist>
  now?: Date
  tz?: string
}

export function MealPlanSheet({ week, items, events, recipes, places, meals, onCreatePlace, onCreateRecipe, onApply, onToast, onClose, suggest = suggestMeals, now, tz }: Props) {
  const at = () => now ?? new Date()
  const todayKey = dateKey(at())
  const weekStart = dateKey(week.start)
  const propose = (lunches: boolean) => proposeMealWeek({ items, events, weekStart, todayKey, lunches, now: at(), tz })
  const [lunches, setLunches] = useState(false)
  const [rows, setRows] = useState<RowState[]>(() => propose(false).map(toState))
  const [picking, setPicking] = useState<string | null>(null)
  const [request, setRequest] = useState('')
  const [assist, setAssist] = useState<Assist>({ status: 'idle' })
  const [done, setDone] = useState<{ count: number; undo(): void } | null>(null)
  const [undone, setUndone] = useState(false)
  const [nothingLeft, setNothingLeft] = useState(false)
  const ids = useId()
  // Pick…'s picker says when each recipe was last cooked, as the Kitchen's does
  const cooked = useMemo(() => cookedIndex(recipes, meals, todayKey), [recipes, meals, todayKey])
  const visited = useMemo(() => visitIndex(places, items.filter((i): i is Task => (i as Task | null)?.kind === 'task'), meals, now ?? new Date()), [places, items, meals, now])

  const setRow = (key: string, patch: Partial<RowState>) => setRows(cur => cur.map(r => (r.key === key ? { ...r, ...patch } : r)))

  // a lunch row appears or goes; the dinners keep whatever was picked for them
  const toggleLunches = () => {
    const next = !lunches
    setLunches(next)
    const fresh = propose(next)
    setRows(cur => fresh.map(r => cur.find(x => x.key === r.key) ?? toState(r)))
  }

  // the ranking's alternatives and the spare new recipes are offered to every
  // night alike, so Swap skips whatever another ticked slot already has
  const optionKey = (c: SlotChoice) => `${c.kind}:${c.id ?? c.title}`
  const swapTo = (r: RowState) => nextSwap(r.options.map(optionKey), r.alt, new Set(rows.flatMap(x => (x.key !== r.key && x.on && x.choice ? [optionKey(x.choice)] : []))))
  const swap = (r: RowState) => {
    const alt = swapTo(r)
    if (alt === null) return
    setRow(r.key, { alt, choice: r.options[alt], on: true })
  }

  const askIdeas = async () => {
    const { input, ids: refs } = mealAssistInput({
      request,
      weekKey: week.key,
      dayKey: todayKey,
      slots: rows.map(r => ({ date: r.date, slot: r.slot })),
      planned: meals.filter(m => weekDayKeys(weekStart).includes(m.date)).map(m => ({ date: m.date, slot: m.slot, title: mealLabel(m) })),
      history: mealHistory(items, { dayKey: todayKey, now: at(), tz }),
    })
    setAssist({ status: 'busy' })
    try {
      const res = await suggest(input)
      const ideas: Record<string, SlotChoice> = {}
      for (const s of res.suggestions) {
        const choice = choiceFromSuggestion(s, refs, recipes, places)
        if (choice) ideas[`${s.date}|${s.slot}`] = choice
      }
      setAssist({ status: 'done', ideas, note: res.note })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const kind = aiFailureKind(message)
      setAssist({
        status: 'failed',
        message:
          kind === 'busy'
            ? 'The assistant is busy — try again in a minute.'
            : kind === 'unavailable'
              ? 'The assistant isn’t available here — the picks above still work.'
              : `Couldn’t get ideas: ${message}`,
      })
    }
  }

  const ideaFor = (r: RowState) => (assist.status === 'done' ? (assist.ideas[r.key] ?? null) : null)
  const takeIdea = (r: RowState) => {
    const idea = ideaFor(r)
    if (idea) setRow(r.key, { choice: idea, on: true })
  }
  const waiting = rows.filter(r => {
    const idea = ideaFor(r)
    return idea && !sameChoice(idea, r.choice)
  })
  const acceptAll = () =>
    setRows(cur =>
      cur.map(r => {
        const idea = assist.status === 'done' ? assist.ideas[r.key] : undefined
        return idea ? { ...r, choice: idea, on: true } : r
      }),
    )

  const picks: MealPick[] = rows.filter(r => r.on && r.choice).map(r => ({ date: r.date, slot: r.slot, choice: r.choice! }))
  const apply = () => {
    const res = onApply(picks)
    if (!res) {
      setNothingLeft(true)
      return
    }
    const msg = `Planned ${res.count} meal${res.count === 1 ? '' : 's'} — the grocery list is updated`
    if (onToast) {
      onToast(msg, res.undo)
      onClose()
      return
    }
    setDone(res)
  }

  if (done)
    return (
      <Modal onClose={onClose} className="modal meal-plan-sheet">
        <ModalHead title="Plan this week’s meals" />
        <div className="modal-body">
          <p className="meal-plan-done" role="status">
            {undone
              ? 'Undone — nothing from this plan is on the week any more.'
              : `✓ Planned ${done.count} meal${done.count === 1 ? '' : 's'} for ${week.label}. The grocery list is updated.`}
          </p>
        </div>
        <footer className="modal-foot">
          {!undone && (
            <button
              className="btn"
              onClick={() => {
                done.undo()
                setUndone(true)
              }}
            >
              Undo
            </button>
          )}
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </Modal>
    )

  return (
    <Modal onClose={onClose} className="modal meal-plan-sheet">
      <ModalHead title="Plan this week’s meals" />
      <div className="modal-body">
        <p className="week-plan-sub">
          {week.label} · picks from what you cook most. Swap, pick your own, or ask the assistant — nothing is planned until you press Plan.
        </p>
        <label className="meal-plan-lunch">
          <input type="checkbox" className="tcheck" checked={lunches} onChange={toggleLunches} />
          Include lunches
        </label>

        {rows.length === 0 ? (
          <p className="empty">Every {lunches ? 'lunch and dinner' : 'dinner'} left this week is planned already.</p>
        ) : (
          <ul className="week-plan-rows meal-plan-rows">
            {rows.map(r => {
              const idea = ideaFor(r)
              const meta = MEAL_SLOT_META[r.slot]
              return (
                <li key={r.key} className={r.on ? 'week-plan-row' : 'week-plan-row off'}>
                  <input
                    type="checkbox"
                    className="tcheck"
                    checked={r.on}
                    disabled={!r.choice}
                    onChange={() => setRow(r.key, { on: !r.on })}
                    aria-label={`${meta.label} on ${dayLabel(r.date)}: ${r.choice?.title ?? 'nothing picked'}`}
                  />
                  <div className="week-plan-main">
                    <span className="week-plan-day">
                      {dayLabel(r.date)} · {meta.emoji} {meta.label}
                    </span>
                    <span className="week-plan-title">
                      {r.choice ? r.choice.title : 'Nothing to suggest yet — pick one'}
                      {r.choice?.kind === 'new' && <small className="meal-plan-new"> new recipe</small>}
                    </span>
                    {(r.busy || r.choice?.why) && (
                      <span className="week-plan-why">
                        {r.busy && <span className="week-plan-busy">Busy: {r.busy} · </span>}
                        {r.choice?.ai ? `✨ ${r.choice.why ?? 'The assistant’s idea'}` : r.choice?.why}
                      </span>
                    )}
                    {idea && !sameChoice(idea, r.choice) && (
                      <span className="week-plan-ai">
                        ✨ {idea.title}
                        {idea.kind === 'new' ? ' (new)' : ''}
                        {idea.why ? ` — ${idea.why}` : ''}{' '}
                        <button type="button" className="btn subtle" onClick={() => takeIdea(r)}>
                          Use
                        </button>
                      </span>
                    )}
                    <div className="week-plan-actions">
                      <button type="button" className="btn subtle" onClick={() => swap(r)} disabled={swapTo(r) === null}>
                        Swap
                      </button>
                      <button type="button" className="btn subtle" aria-expanded={picking === r.key} onClick={() => setPicking(p => (p === r.key ? null : r.key))}>
                        Pick…
                      </button>
                    </div>
                    {picking === r.key && (
                      <MealSlotRow
                        date={r.date}
                        slot={r.slot}
                        meal={asMeal(r.date, r.slot, r.choice)}
                        recipes={recipes}
                        places={places}
                        cooked={cooked}
                        visited={visited}
                        mainOnly
                        onSave={m => {
                          const choice: SlotChoice = m.recipeId
                            ? { kind: 'recipe', id: m.recipeId, title: m.title, why: 'Your pick' }
                            : m.placeId
                              ? { kind: 'place', id: m.placeId, title: m.title, why: 'Your pick' }
                              : { kind: 'out', title: m.title, why: 'Your pick' }
                          setRow(r.key, { choice, on: true })
                          setPicking(null)
                        }}
                        onClear={() => {
                          setRow(r.key, { choice: null, on: false })
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
        )}

        {rows.length > 0 && (
          <section className="meal-plan-ai" aria-labelledby={`${ids}-ai`}>
            <h3 id={`${ids}-ai`}>✨ Ask for ideas</h3>
            <form
              className="ask-form"
              onSubmit={e => {
                e.preventDefault()
                void askIdeas()
              }}
            >
              <input
                className="ask-input"
                value={request}
                onChange={e => setRequest(e.target.value)}
                placeholder="Something light, we’re out on Wednesday…"
                aria-label="What would you like this week?"
                maxLength={300}
              />
              <button type="submit" className="btn" disabled={assist.status === 'busy'}>
                {assist.status === 'busy' ? 'Thinking…' : '✨ Ask for ideas'}
              </button>
            </form>
            {assist.status === 'failed' && <p className="ask-note">{assist.message}</p>}
            {assist.status === 'done' && (
              <p className="ask-note">
                {assist.note || (Object.keys(assist.ideas).length ? 'Ideas are under each meal above.' : 'No ideas it could stand behind this time — try asking differently.')}{' '}
                {waiting.length > 0 && (
                  <button type="button" className="btn subtle" onClick={acceptAll}>
                    Accept all {waiting.length}
                  </button>
                )}
              </p>
            )}
          </section>
        )}
        {nothingLeft && <p className="ask-note">Those meals were planned meanwhile — nothing was changed.</p>}
      </div>
      <footer className="modal-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={picks.length === 0} onClick={apply}>
          Plan {picks.length} meal{picks.length === 1 ? '' : 's'}
        </button>
      </footer>
    </Modal>
  )
}
