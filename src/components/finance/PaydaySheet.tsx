import { useState } from 'react'
import { editedMoney, paydayFromForm } from '../../billtemplates'
import { localMidnightIso, newerStamp } from '../../itemops'
import { money } from '../../taskform'
import { RECURRENCE_META, type Bill, type RecurrenceFreq, type Task } from '../../types'
import { dateKey, uid } from '../../utils'
import { isDayKey } from '../../../shared/weeks.mts'
import { Modal, ModalHead } from '../Modal'
import { Segmented } from '../stats/Segmented'
import { SheetActions } from './SheetActions'
import { ShareChoice, ShareField } from './ShareChoice'

// + Payday: whose pay it is, what lands in the account (take-home, never
// before tax), when the next one lands and how often.
// The date is the one thing it will not add without. + Payday used to open
// the full editor, where a date is optional, and a payday saved with none was
// counted nowhere while every bill beside it came off. More options still
// opens the full editor, on whatever is filled in here.
//
// The same sheet edits one (PaydayEditSheet): a tap on a payday anywhere in
// Finance, its card's head included, opens it with the same fields, the date
// still required, and Archive and Delete.

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

interface EditProps {
  /** The payday: its open occurrence, or an archived one to bring back. */
  task: Task & { bill: Bill }
  members: Member[]
  myId?: string | null
  inHousehold: boolean
  onSave(t: Task): void
  /** Archived (cancelled: counted nowhere, kept) or brought back. */
  onArchive(t: Task, archive: boolean): void
  onDelete(t: Task): void
  /** The full editor on it: saved first, when anything here was changed. */
  onEditor(t: Task): void
  onClose(): void
}

/** A payday's short sheet: whose, its name, take-home pay, the next date, how often, and who can see it. */
export function PaydayEditSheet({ task, members, myId, inHousehold, onSave, onArchive, onDelete, onEditor, onClose }: EditProps) {
  const first = task.dueAt && !Number.isNaN(Date.parse(task.dueAt)) ? dateKey(task.dueAt) : ''
  const was = task.recurrence?.freq ?? ''
  const [whose, setWhose] = useState(task.bill.forMemberId ?? '')
  const [name, setName] = useState(task.title)
  const [amount, setAmount] = useState(task.estimateCost !== undefined ? task.estimateCost.toFixed(2) : '')
  const [due, setDue] = useState(first)
  const [freq, setFreq] = useState<RecurrenceFreq | ''>(was)
  const [shared, setShared] = useState(task.shared !== false)

  // the three pay comes in, and whatever this one already goes by
  const often: { key: RecurrenceFreq | ''; label: string }[] = [...OFTEN]
  if (!OFTEN.some(o => o.key === was)) often.push({ key: was, label: was ? RECURRENCE_META[was] : 'Once' })

  const value = money(amount)
  const dated = isDayKey(due)
  const ready = !!name.trim() && value !== undefined && dated
  const reshared = inHousehold && shared !== (task.shared !== false)
  const changed = name !== task.title || value !== task.estimateCost || due !== first || freq !== was || whose !== (task.bill.forMemberId ?? '') || reshared
  const edited = () => (value === undefined ? null : editedMoney(task, { name, amount: value, due, freq: freq || null, whose: whose || null, ...(reshared ? { shared } : {}) }, newerStamp(task.updatedAt)))

  const close = () => {
    if (changed && !window.confirm('Discard your changes?')) return
    onClose()
  }
  const save = () => {
    const next = ready && changed ? edited() : null
    if (next) onSave(next)
    else if (ready) onClose()
  }
  const more = () => {
    if (changed && !ready && !window.confirm('Discard your changes?')) return
    const next = ready && changed ? edited() : null
    if (next) onSave(next)
    onEditor(next ?? task)
  }

  return (
    <Modal onClose={close} className="modal narrow fin-sheet payday-sheet payday-edit">
      {/* one still called Payday is named for whose it is, as its row names it (moneyName) */}
      <ModalHead title={`💵 ${name.trim() && name.trim() !== 'Payday' ? name.trim() : payName(members, whose || undefined)}`} variant="compose">
        <button type="button" className="btn primary" disabled={!ready} onClick={save}>
          Save
        </button>
      </ModalHead>
      <div className="modal-body">
        {members.length > 1 && (
          <div className="field">
            <span>Whose pay</span>
            {/* one written before whose it was said stays so until it is picked: no member is lit for it */}
            <Segmented items={[...(task.bill.forMemberId ? [] : [{ key: '', label: 'Not said' }]), ...members.map(m => ({ key: m.id, label: m.displayName }))]} value={whose} onChange={setWhose} label="Whose pay" role="group" />
          </div>
        )}
        <label className="field">
          <span>Name</span>
          <input value={name} placeholder="e.g. Maria’s pay" onChange={e => setName(e.target.value)} />
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
        {!dated && <p className="field-hint fin-sheet-hint">{due ? 'That is not a date.' : 'When the next one lands: Finance counts every payday from its date, the way it counts the bills.'}</p>}
        <div className="field">
          <span>How often</span>
          <Segmented items={often} value={freq} onChange={k => setFreq(k)} label="How often" role="group" />
        </div>
        {inHousehold && <ShareField ownerId={task.ownerId} myId={myId} members={members} shared={shared} onChange={setShared} noun="payday" />}
        {amount.trim() && value === undefined && <p className="warn">That is not an amount.</p>}
        <SheetActions archived={task.status === 'canceled'} onMore={more} onArchive={() => onArchive(task, task.status !== 'canceled')} onDelete={() => onDelete(task)} />
      </div>
    </Modal>
  )
}
