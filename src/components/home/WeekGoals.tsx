import { useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Review } from '../../types'
import { haptic } from '../../native'
import { uid } from '../../utils'
import { WEEK_GOALS, allDoneLine, finishesGoals, goalsOf, withGoalToggled, withWeekGoals, type WeekGoal } from '../../weekgoals'

const BLANK: readonly string[] = ['', '', '']
/** The bits of the burst, each on its own spoke. */
const BITS = 12

/** Reduce Motion asked for: the cheer is its words alone. Read when a goal is ticked, never as the card draws. */
function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** A pointer that aims. Only there may Edit move the caret too: on a phone that would raise the keyboard over the card. */
function finePointer(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches
}

/** "1/3", drawn: the week's ticks as a ring, the count in the hole. */
function GoalRing({ done, of, children }: { done: number; of: number; children?: ReactNode }) {
  const r = 20
  const circ = 2 * Math.PI * r
  const share = of > 0 ? Math.min(1, done / of) : 0
  return (
    <span className="goals-ring" role="img" aria-label={of > 0 ? `${done} of ${of} done` : 'No goals yet'}>
      <svg viewBox="0 0 48 48" width={48} height={48} aria-hidden="true">
        <circle className="goals-ring-track" cx={24} cy={24} r={r} fill="none" strokeWidth={5} />
        {share > 0 && (
          <circle
            className="goals-ring-arc"
            cx={24}
            cy={24}
            r={r}
            fill="none"
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={`${circ * share} ${circ}`}
            transform="rotate(-90 24 24)"
          />
        )}
      </svg>
      <span className="goals-ring-count" aria-hidden="true">
        {done}/{of || WEEK_GOALS}
      </span>
      {children}
    </span>
  )
}

export interface WeekGoalsProps {
  /** Every review of the member's own (store.reviews): where a new week's goals are written. */
  reviews: Review[]
  /** The record whose Top 3 are this week's (weekGoalsRecord), when there is one. */
  record?: Review
  /** A moment on today, from Home's clock: which week "this week" is. */
  noon: Date
  /** Today's focus tasks' titles, lower case: a goal that is one of them says so. */
  focusTitles: ReadonlySet<string>
  onSave(r: Review): void
  /** "→ task": the goal as a new task, in the editor. */
  onMakeTask(line: string): void
  /** Plan next week, offered here on a Sunday when nothing else on Home offers it. */
  onPlanWeek?(): void
}

/**
 * This week's 3, at the head of Home: set here, edited here and ticked here.
 *
 * They are the Review's Top 3 (src/weekgoals.ts), so the Sunday review ticks
 * the same lines and a goal set in either place is the other's too. With none
 * set the card asks for them, three lines and Save; Edit opens the same
 * lines. The ring counts the ticks. Ticking the last one cheers — a burst
 * round the ring, the words, and a success buzz on the phone — once for that
 * tick, never as the card draws; with Reduce Motion on, only the words.
 */
export function WeekGoals({ reviews, record, noon, focusTitles, onSave, onMakeTask, onPlanWeek }: WeekGoalsProps) {
  const goals = goalsOf(record)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<readonly string[]>(BLANK)
  const [burst, setBurst] = useState(0)
  const fields = useRef<(HTMLInputElement | null)[]>([])
  const titleId = useId()
  const done = goals.filter(g => g.done).length
  const allDone = goals.length > 0 && done === goals.length
  const typed = draft.some(line => line.trim())
  // what was typed stays up, even if goals arrive from another device meanwhile
  const asking = editing || goals.length === 0 || typed

  const toggle = (g: WeekGoal) => {
    if (!record) return
    const finishing = finishesGoals(goals, g.index)
    onSave(withGoalToggled(record, g.index))
    if (!finishing) return
    void haptic('success')
    if (!reducedMotion()) setBurst(n => n + 1)
  }

  const edit = () => {
    setDraft([...goals.map(g => g.text), ...BLANK].slice(0, WEEK_GOALS))
    setEditing(true)
    if (finePointer()) setTimeout(() => fields.current[0]?.focus(), 0)
  }

  const close = () => {
    setEditing(false)
    setDraft(BLANK)
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    // nothing typed and nothing to clear
    if (!typed && goals.length === 0) return
    onSave(withWeekGoals(reviews, draft, { noon, now: new Date(), newId: uid }))
    close()
  }

  // Return moves to the next line, as a form of three lines should; the last one saves
  const onKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || i >= WEEK_GOALS - 1) return
    e.preventDefault()
    fields.current[i + 1]?.focus()
  }

  const heading = asking && goals.length === 0 ? 'Set this week’s 3' : 'This week’s 3'
  const sub = asking ? 'What would make it a good week?' : allDone ? allDoneLine(goals.length) : 'Tick them off as the week goes'

  return (
    <section className={'chart-card home-goals' + (allDone && !asking ? ' all-done' : '')} aria-labelledby={titleId}>
      <header className="goals-head">
        <GoalRing done={done} of={goals.length}>
          {burst > 0 && (
            <span key={burst} className="goals-burst" aria-hidden="true">
              {Array.from({ length: BITS }, (_, i) => (
                <i key={i} style={{ '--bit': i } as CSSProperties} onAnimationEnd={i === BITS - 1 ? () => setBurst(0) : undefined} />
              ))}
            </span>
          )}
        </GoalRing>
        <div className="goals-words">
          <h3 id={titleId}>{heading}</h3>
          {/* said aloud when it changes, so the cheer's words reach VoiceOver too.
              A live region, not role="status": that is the toast's, and Home has one of it */}
          <p className={allDone && !asking ? 'chart-sub goals-cheer' : 'chart-sub'} aria-live="polite">
            {sub}
          </p>
        </div>
        {!asking && (
          <button type="button" className="btn subtle home-link" onClick={edit}>
            Edit
          </button>
        )}
      </header>

      {asking ? (
        <form className="goals-form" onSubmit={save}>
          {BLANK.map((_, i) => (
            <input
              key={i}
              ref={el => {
                fields.current[i] = el
              }}
              className="goals-input"
              value={draft[i] ?? ''}
              placeholder={i === 0 ? 'The one that matters most' : i === 1 ? 'A second' : 'And a third'}
              aria-label={`Goal ${i + 1}`}
              enterKeyHint={i < WEEK_GOALS - 1 ? 'next' : 'done'}
              maxLength={120}
              onChange={e => setDraft(cur => cur.map((x, j) => (j === i ? e.target.value : x)))}
              onKeyDown={onKey(i)}
            />
          ))}
          <div className="goals-foot">
            {onPlanWeek && (
              <button type="button" className="btn subtle home-link goals-plan" onClick={onPlanWeek}>
                Plan next week
              </button>
            )}
            {editing && (
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn primary" disabled={!typed && goals.length === 0}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <ul className="dash-list goals-list">
            {goals.map(g => (
              <li key={g.index} className={g.done ? 'trow done' : 'trow'}>
                {/* the whole line ticks it, not only the box: a thumb's target */}
                <label className="dash-main goals-tick">
                  <input type="checkbox" className="tcheck" checked={g.done} aria-label={`Mark “${g.text}” ${g.done ? 'not done' : 'done'}`} onChange={() => toggle(g)} />
                  {/* the words and the badge flow as a line of text: the badge wraps under a long goal, never the goal under its box */}
                  <span className="goals-words-line">
                    <span className="dash-title">{g.text}</span>
                    {/* the line stays; its task is on the focus card below too */}
                    {focusTitles.has(g.text.toLowerCase()) && (
                      <>
                        {' '}
                        <span className="badge focus-badge">Today’s focus</span>
                      </>
                    )}
                  </span>
                </label>
                {!g.done && (
                  <button type="button" className="btn subtle goals-task" aria-label={`Make “${g.text}” a task`} title="Make it a task" onClick={() => onMakeTask(g.text)}>
                    → task
                  </button>
                )}
              </li>
            ))}
          </ul>
          {onPlanWeek && (
            <p className="goals-foot">
              <button type="button" className="btn subtle home-link goals-plan" onClick={onPlanWeek}>
                Plan next week
              </button>
            </p>
          )}
        </>
      )}
    </section>
  )
}
