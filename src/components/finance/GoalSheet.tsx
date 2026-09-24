import { useMemo, useState } from 'react'
import { GOAL_EMOJI, goalFromForm } from '../../billtemplates'
import { formatMoney } from '../../bills'
import { savingGoals, type GoalView } from '../../finance'
import { money } from '../../taskform'
import { RECURRENCE_META, type RecurrenceFreq, type Task } from '../../types'
import { uid } from '../../utils'
import { isDayKey } from '../../../shared/weeks.mts'
import { Modal, ModalHead } from '../Modal'
import { PER, shortDay } from './labels'
import { ShareChoice } from './ShareChoice'

// + Goal: something to save towards. A goal is a repeating set-aside with the
// target on it — no record of its own — so it sits on the calendar and in the
// reminders like a bill, and what it has saved is what its set-asides paid in.

/** What the goal as filled in would do: "7 set-asides by Dec 31 reach $1,400.00." */
function previewLine(p: GoalView): string {
  const count = (k: number, one: string, many: string) => (k === 1 ? `One set-aside ${one}` : `${k} set-asides ${many}`)
  if (p.by) {
    const by = shortDay(p.by)
    if (!p.left) return `The first set-aside comes after ${by}.`
    if (p.status === 'on-track') return `${count(p.left, `by ${by} reaches`, `by ${by} reach`)} ${formatMoney(p.target)}.`
    const short = count(p.left, `by ${by} comes to`, `by ${by} come to`)
    return `${short} ${formatMoney(p.projected ?? 0)}${p.needed !== undefined ? ` — ${formatMoney(p.needed)} each would reach ${formatMoney(p.target)}` : ''}.`
  }
  const each = `of ${formatMoney(p.each)}${p.freq ? ` ${PER[p.freq]}` : ''}`
  return `${count(p.toGo ?? 0, `${each} reaches`, `${each} reach`)} ${formatMoney(p.target)}.`
}

interface Props {
  /** Today's key: the first set-aside starts on it unless moved. */
  today: string
  /** Noon today: what the hint below counts from. */
  at: Date
  inHousehold: boolean
  onAdd(t: Task): void
  onClose(): void
}

export function GoalSheet({ today, at, inHousehold, onAdd, onClose }: Props) {
  const [emoji, setEmoji] = useState<string>(GOAL_EMOJI[0])
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [by, setBy] = useState('')
  const [amount, setAmount] = useState('')
  const [freq, setFreq] = useState<RecurrenceFreq>('monthly')
  const [first, setFirst] = useState(today)
  const [autopay, setAutopay] = useState(false)
  const [shared, setShared] = useState(true)

  const goal = money(target)
  const each = money(amount)
  const ready = !!name.trim() && !!goal && goal > 0 && !!each && each > 0 && isDayKey(first) && (!by || isDayKey(by))
  // what it would do, worked out as the card will: the same savingGoals
  const draft = useMemo(
    () => (goal && goal > 0 && each && isDayKey(first) ? goalFromForm({ name: name || 'Goal', emoji, target: goal, by: isDayKey(by) ? by : undefined, amount: each, freq, first, autopay: false }, { id: 'draft', now: '' }) : null),
    [goal, each, first, by, freq, name, emoji],
  )
  const preview = useMemo(() => (draft ? (savingGoals([draft], at)[0] ?? null) : null), [draft, at])

  const close = () => {
    if ((name.trim() || target.trim() || amount.trim()) && !window.confirm('Discard this goal?')) return
    onClose()
  }
  const add = () => {
    if (!ready || !goal || !each) return
    onAdd(goalFromForm({ name, emoji, target: goal, by: by || undefined, amount: each, freq, first, autopay, ...(inHousehold ? { shared } : {}) }, { id: uid(), now: new Date().toISOString() }))
  }

  return (
    <Modal onClose={close} className="modal narrow fin-sheet goal-sheet">
      <ModalHead title="New goal" variant="compose">
        <button type="button" className="btn primary" disabled={!ready} onClick={add}>
          Add
        </button>
      </ModalHead>
      <div className="modal-body">
        <div className="field">
          <span>Saving for</span>
          <div className="goal-emoji" role="radiogroup" aria-label="Emoji">
            {GOAL_EMOJI.map(e => (
              <button key={e} type="button" role="radio" aria-checked={emoji === e} className={emoji === e ? 'goal-emoji-pick on' : 'goal-emoji-pick'} onClick={() => setEmoji(e)}>
                {e}
              </button>
            ))}
          </div>
          <input value={name} placeholder="e.g. Emergency fund" aria-label="Goal name" onChange={e => setName(e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field">
            <span>Target</span>
            <input className="fin-amount-input" inputMode="decimal" autoComplete="off" value={target} placeholder="$0.00" onChange={e => setTarget(e.target.value)} />
          </label>
          <label className="field">
            <span>By (optional)</span>
            <input type="date" value={by} min={today} onChange={e => setBy(e.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Set aside</span>
            <input className="fin-amount-input" inputMode="decimal" autoComplete="off" value={amount} placeholder="$0.00" onChange={e => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span>How often</span>
            <select value={freq} onChange={e => setFreq(e.target.value as RecurrenceFreq)}>
              {(Object.keys(RECURRENCE_META) as RecurrenceFreq[]).map(f => (
                <option key={f} value={f}>
                  {RECURRENCE_META[f]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>First one</span>
            <input type="date" value={first} onChange={e => setFirst(e.target.value)} />
          </label>
          <label className="field-inline fin-autopay">
            <input type="checkbox" checked={autopay} onChange={e => setAutopay(e.target.checked)} />
            <span>Moved automatically</span>
          </label>
        </div>
        {preview && (
          <p className={preview.status === 'behind' ? 'fin-preview behind' : 'fin-preview'} aria-live="polite">
            {previewLine(preview)}
          </p>
        )}
        {inHousehold && <ShareChoice shared={shared} onChange={setShared} noun="goal" />}
        {((target.trim() && !goal) || (amount.trim() && !each)) && <p className="warn">That is not an amount.</p>}
      </div>
    </Modal>
  )
}
