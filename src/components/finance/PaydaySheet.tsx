import { useState } from 'react'
import { paydayFromForm } from '../../billtemplates'
import { localMidnightIso } from '../../itemops'
import { money } from '../../taskform'
import type { Task } from '../../types'
import { uid } from '../../utils'
import { isDayKey } from '../../../shared/weeks.mts'
import { Modal, ModalHead } from '../Modal'
import { Segmented } from '../stats/Segmented'
import { ShareChoice } from './ShareChoice'

// + Payday: whose pay it is, what lands in the account (take-home, never
// before tax), when the next one lands and how often.
// The date is the one thing it will not add without. + Payday used to open
// the full editor, where a date is optional, and a payday saved with none was
// counted nowhere while every bill beside it came off. More options still
// opens the full editor, on whatever is filled in here.

type Member = { id: string; displayName: string }

/** The cadences pay comes in; the editor's Repeat has the rest. */
const OFTEN = [
  { key: 'weekly', label: 'Weekly' },
  { key: 'biweekly', label: 'Every 2 weeks' },
  { key: 'monthly', label: 'Monthly' },
] as const
type Often = (typeof OFTEN)[number]['key']

/** "Maria’s pay": what a payday is called until it is named, as a row calls one (moneyName). */
const payName = (members: readonly Member[], id: string | undefined): string => {
  const who = id ? members.find(m => m.id === id)?.displayName : undefined
  return who ? `${who}’s pay` : 'Payday'
}

interface Props {
  /** The household, so the payday says whose it is. Alone, there is no one to choose between. */
  members: Member[]
  /** The reader: it is their pay until someone else is picked. */
  myId?: string | null
  /** More than one member: the payday says who can see it. */
  inHousehold: boolean
  /** A payday filled in here, to write as it is. */
  onAdd(t: Task): void
  /** The task editor on a new payday, with whatever was filled in here. */
  onMore(preset: Partial<Task>): void
  onClose(): void
}

export function PaydaySheet({ members, myId, inHousehold, onAdd, onMore, onClose }: Props) {
  const [whose, setWhose] = useState<string | undefined>(() => members.find(m => m.id === myId)?.id)
  const [name, setName] = useState(() => payName(members, whose))
  // the name follows whose pay it is until it is typed over
  const [named, setNamed] = useState(false)
  const [amount, setAmount] = useState('')
  const [due, setDue] = useState('')
  const [freq, setFreq] = useState<Often>('biweekly')
  // money is the household's picture, as the accounts are: shared unless kept back
  const [shared, setShared] = useState(true)

  const value = money(amount)
  const dated = isDayKey(due)
  const ready = !!name.trim() && value !== undefined && dated
  const typedIn = named || !!amount.trim() || !!due

  const pickWhose = (id: string) => {
    setWhose(id)
    if (!named) setName(payName(members, id))
  }
  const close = () => {
    if (typedIn && !window.confirm('Discard this payday?')) return
    onClose()
  }
  const add = () => {
    if (!ready || value === undefined) return
    onAdd(paydayFromForm({ name, whose, amount: value, due, freq, ...(inHousehold ? { shared } : {}) }, { id: uid(), now: new Date().toISOString() }))
  }
  const more = () => {
    onMore({
      title: name.trim(),
      bill: { kind: 'income', ...(whose ? { forMemberId: whose } : {}) },
      recurrence: { freq },
      ...(value !== undefined ? { estimateCost: value } : {}),
      ...(dated ? { dueAt: localMidnightIso(due) ?? undefined } : {}),
      ...(inHousehold ? { shared } : {}),
    })
  }

  return (
    <Modal onClose={close} className="modal narrow fin-sheet payday-sheet">
      <ModalHead title={`💵 ${name.trim() || 'New payday'}`} variant="compose">
        <button type="button" className="btn primary" disabled={!ready} onClick={add}>
          Add
        </button>
      </ModalHead>
      <div className="modal-body">
        {members.length > 1 && (
          <div className="field">
            <span>Whose pay</span>
            <Segmented items={members.map(m => ({ key: m.id, label: m.displayName }))} value={whose ?? ''} onChange={pickWhose} label="Whose pay" role="group" />
          </div>
        )}
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            placeholder="e.g. Maria’s pay"
            onChange={e => {
              setName(e.target.value)
              setNamed(true)
            }}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Take-home pay</span>
            <input className="fin-amount-input" inputMode="decimal" autoComplete="off" value={amount} placeholder="$0.00" onChange={e => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span>Next payday</span>
            <input type="date" required value={due} onChange={e => setDue(e.target.value)} />
          </label>
        </div>
        {!dated && (
          <p className="field-hint fin-sheet-hint">
            {due ? 'That is not a date.' : 'When the next one lands: Finance counts every payday from its date, the way it counts the bills.'}
          </p>
        )}
        <div className="field">
          <span>How often</span>
          <Segmented items={OFTEN} value={freq} onChange={k => setFreq(k)} label="How often" role="group" />
        </div>
        {inHousehold && <ShareChoice shared={shared} onChange={setShared} noun="payday" />}
        {amount.trim() && value === undefined && <p className="warn">That is not an amount.</p>}
        <button type="button" className="btn subtle fin-more" onClick={more}>
          More options…
        </button>
      </div>
    </Modal>
  )
}
