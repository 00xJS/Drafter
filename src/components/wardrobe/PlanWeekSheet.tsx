import { useState } from 'react'
import { shortDay } from '../../kitchen'
import type { Garment } from '../../types'
import { DAY_OCCASION_LABEL, outfitLabel } from '../../wardrobe'
import { Icon } from '../Icon'
import { Modal, ModalHead } from '../Modal'
import { proposeWeek, redealDay, type Idea, type PlanSource } from './board'
import { Collage } from './GarmentPhoto'

interface Props {
  /** The days to plan, in order: the shown week's from today on that have no look. */
  days: readonly string[]
  /** "13 – 19 Sep": the week they are in. */
  week: string
  todayKey: string
  /** What each day is dealt from: the wardrobe, its rest, each day's occasion and today's coat. */
  source: PlanSource
  /** The tops, bottoms and one-pieces the week's looks hold already: steered round. */
  taken: ReadonlySet<string>
  byId: ReadonlyMap<string, Garment>
  /** The ticked days' looks, to plan as one batch. */
  onPlan(plans: { day: string; pieces: string[] }[]): void
  onClose(): void
}

/**
 * Plan the week: a look for each day of the shown week that has none yet,
 * from today on — dealt as the ideas are, for each day's occasion and season,
 * no top, bottom or one-piece twice while the wardrobe allows. Each day can be
 * dealt again or left unticked. Nothing is written until Plan, which files the
 * ticked days as plans in one go; the board's toast undoes the lot.
 */
export function PlanWeekSheet({ days: offered, week, todayKey, source, taken, byId, onPlan, onClose }: Props) {
  // the days and their looks are dealt once, as the sheet opens; each Another
  // moves one day on from there, and a sync under the sheet changes neither
  const [days] = useState(offered)
  const [plan, setPlan] = useState<Record<string, Idea | null>>(() => proposeWeek(source, offered, taken))
  const [deals, setDeals] = useState<Record<string, number>>({})
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set())
  const ticked = days.filter(d => !!plan[d] && !skipped.has(d))

  const another = (day: string) => {
    const deal = (deals[day] ?? 0) + 1
    setDeals({ ...deals, [day]: deal })
    setPlan({ ...plan, [day]: redealDay(source, plan, day, taken, deal) })
  }
  const tick = (day: string, on: boolean) => {
    const next = new Set(skipped)
    if (on) next.delete(day)
    else next.add(day)
    setSkipped(next)
  }
  const name = (day: string) => (day === todayKey ? `Today · ${shortDay(day, todayKey)}` : shortDay(day, todayKey))

  return (
    <Modal onClose={onClose} className="modal narrow plan-week-sheet">
      <ModalHead title="Plan the week" />
      <div className="modal-body">
        <p className="plan-week-sub">
          {week} · {days.length === 1 ? 'one day' : `${days.length} days`} without a look
        </p>
        <ul className="plan-week-days">
          {days.map(day => {
            const idea = plan[day]
            const on = !!idea && !skipped.has(day)
            const occasion = DAY_OCCASION_LABEL[source.occasionOf(day)]
            return (
              <li key={day} className={on ? 'plan-week-day' : 'plan-week-day off'}>
                <label className="plan-week-tick">
                  <input type="checkbox" className="tcheck" checked={on} disabled={!idea} aria-label={`Plan ${name(day)}`} onChange={e => tick(day, e.target.checked)} />
                </label>
                {idea ? <Collage ids={idea.ids} byId={byId} className="plan-week-look" /> : <span className="collage plan-week-look" aria-hidden="true" />}
                <span className="plan-week-text">
                  <span className="plan-week-when">
                    {name(day)} · {occasion}
                  </span>
                  <span className="plan-week-what">{idea ? (on ? outfitLabel(idea.ids, byId) : 'Skipped') : `Nothing fits a ${occasion.toLowerCase()} yet`}</span>
                </span>
                {idea && (
                  <button type="button" className="btn subtle plan-week-again" aria-label={`Another look for ${name(day)}`} title="Another look" disabled={!on} onClick={() => another(day)}>
                    <Icon name="shuffle" size={16} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      <footer className="modal-foot plan-week-foot">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={ticked.length === 0}
          onClick={() => {
            onPlan(ticked.map(day => ({ day, pieces: plan[day]!.ids })))
            onClose()
          }}
        >
          {ticked.length === 1 ? 'Plan 1 day' : `Plan ${ticked.length} days`}
        </button>
      </footer>
    </Modal>
  )
}
