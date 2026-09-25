import { useState } from 'react'
import { BILL_TEMPLATES, TEMPLATE_GROUPS, billFromTemplate, editedMoney, type BillTemplate } from '../../billtemplates'
import { billEmoji } from '../../bills'
import { localMidnightIso, newerStamp } from '../../itemops'
import { money } from '../../taskform'
import { RECURRENCE_META, type Bill, type RecurrenceFreq, type Task } from '../../types'
import { dateKey, uid } from '../../utils'
import { isDayKey } from '../../../shared/weeks.mts'
import { Modal, ModalHead } from '../Modal'
import { SheetActions } from './SheetActions'
import { ShareChoice, ShareField } from './ShareChoice'

// + Bill: pick what it is — rent, the electric, Netflix — and the name, the
// kind, the emoji and how often it comes round are filled in. What is left is
// what only you know: how much, and when it is next due. More options opens
// the full editor on the same bill, for anything the short form leaves out.
//
// The same sheet edits one: a tap on a bill or a set-aside anywhere in
// Finance opens it on that bill, with the fields it was added with, a date it
// will not save without, and Archive and Delete. The full editor is still
// More options away.

const FREQS = Object.keys(RECURRENCE_META) as RecurrenceFreq[]

type Member = { id: string; displayName: string }

interface Props {
  /** More than one member: the bill says who can see it. */
  inHousehold: boolean
  /** A bill filled in here, to write as it is. */
  onAdd(t: Task): void
  /** The task editor on a new bill, with whatever was filled in here. */
  onMore(preset: Partial<Task>): void
  onClose(): void
}

export function BillSheet({ inHousehold, onAdd, onMore, onClose }: Props) {
  const [picked, setPicked] = useState<BillTemplate | null>(null)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [due, setDue] = useState('')
  const [freq, setFreq] = useState<RecurrenceFreq>('monthly')
  const [autopay, setAutopay] = useState(false)
  // money is the household's picture, as the accounts are: shared unless kept back
  const [shared, setShared] = useState(true)

  const pick = (t: BillTemplate) => {
    setPicked(t)
    setName(t.name)
    setFreq(t.freq)
  }
  const value = money(amount)
  const ready = !!picked && !!name.trim() && value !== undefined && isDayKey(due)
  const typedIn = !!picked && (name !== picked.name || !!amount.trim() || !!due || autopay)

  const close = () => {
    if (typedIn && !window.confirm('Discard this bill?')) return
    onClose()
  }
  const add = () => {
    if (!picked || !ready || value === undefined) return
    onAdd(billFromTemplate(picked, { name, amount: value, due, freq, autopay, ...(inHousehold ? { shared } : {}) }, { id: uid(), now: new Date().toISOString() }))
  }
  const more = () => {
    const kind = picked?.kind ?? 'bill'
    onMore({
      title: name.trim(),
      bill: { kind, ...(picked?.emoji ? { emoji: picked.emoji } : {}), ...(autopay ? { autopay: true } : {}) },
      recurrence: { freq },
      ...(value !== undefined ? { estimateCost: value } : {}),
      ...(isDayKey(due) ? { dueAt: localMidnightIso(due) ?? undefined } : {}),
      ...(inHousehold ? { shared } : {}),
    })
  }

  if (!picked) {
    return (
      <Modal onClose={onClose} className="modal narrow fin-sheet bill-picker">
        <ModalHead title="Add a bill" />
        <div className="modal-body">
          <p className="field-hint fin-sheet-hint">Pick what it is, then say how much and when it is next due.</p>
          {TEMPLATE_GROUPS.map(g => (
            <section key={g.key} className="tpl-group" aria-label={g.label}>
              <h3 className="bills-head">{g.label}</h3>
              <ul className="tpl-grid">
                {BILL_TEMPLATES.filter(t => t.group === g.key).map(t => (
                  <li key={t.key}>
                    <button type="button" className="tpl" onClick={() => pick(t)}>
                      <span className="tpl-emoji" aria-hidden="true">
                        {t.emoji}
                      </span>
                      <span className="tpl-name">{t.name || 'Other'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Modal>
    )
  }

  return (
    <Modal onClose={close} className="modal narrow fin-sheet bill-form">
      <ModalHead title={`${picked.emoji} ${name.trim() || 'New bill'}`} variant="compose">
        <button type="button" className="btn primary" disabled={!ready} onClick={add}>
          Add
        </button>
      </ModalHead>
      <div className="modal-body">
        <button type="button" className="btn subtle fin-back" onClick={() => setPicked(null)}>
          ‹ All bills
        </button>
        <label className="field">
          <span>Name</span>
          <input value={name} placeholder="e.g. Pest control" onChange={e => setName(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Amount due</span>
            <input className="fin-amount-input" inputMode="decimal" autoComplete="off" value={amount} placeholder="$0.00" onChange={e => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span>Next due</span>
            <input type="date" required value={due} onChange={e => setDue(e.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Repeats</span>
            <select value={freq} onChange={e => setFreq(e.target.value as RecurrenceFreq)}>
              {FREQS.map(f => (
                <option key={f} value={f}>
                  {RECURRENCE_META[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline fin-autopay">
            <input type="checkbox" checked={autopay} onChange={e => setAutopay(e.target.checked)} />
            <span>Paid automatically</span>
          </label>
        </div>
        {inHousehold && <ShareChoice shared={shared} onChange={setShared} noun="bill" />}
        {amount.trim() && value === undefined && <p className="warn">That is not an amount.</p>}
        <button type="button" className="btn subtle fin-more" onClick={more}>
          More options…
        </button>
      </div>
    </Modal>
  )
}

interface EditProps {
  /** The bill or set-aside: its open occurrence, or an archived one to bring back. */
  task: Task & { bill: Bill }
  inHousehold: boolean
  /** The reader and the household: only a bill's owner can keep it from the other. */
  myId?: string | null
  members: Member[]
  onSave(t: Task): void
  /** Archived (cancelled: counted nowhere, kept) or brought back. */
  onArchive(t: Task, archive: boolean): void
  onDelete(t: Task): void
  /** The full editor on it: saved first, when anything here was changed. */
  onEditor(t: Task): void
  onClose(): void
}

/** A bill or a set-aside's short sheet: name, amount, next date, how often, whether it goes by itself, and who can see it. */
export function BillEditSheet({ task, inHousehold, myId, members, onSave, onArchive, onDelete, onEditor, onClose }: EditProps) {
  const saving = task.bill.kind === 'saving'
  const first = task.dueAt && !Number.isNaN(Date.parse(task.dueAt)) ? dateKey(task.dueAt) : ''
  const [name, setName] = useState(task.title)
  const [amount, setAmount] = useState(task.estimateCost !== undefined ? task.estimateCost.toFixed(2) : '')
  const [due, setDue] = useState(first)
  const [freq, setFreq] = useState<RecurrenceFreq | ''>(task.recurrence?.freq ?? '')
  const [autopay, setAutopay] = useState(!!task.bill.autopay)
  const [shared, setShared] = useState(task.shared !== false)

  const value = money(amount)
  const dated = isDayKey(due)
  const ready = !!name.trim() && value !== undefined && dated
  const reshared = inHousehold && shared !== (task.shared !== false)
  const changed = name !== task.title || value !== task.estimateCost || due !== first || freq !== (task.recurrence?.freq ?? '') || autopay !== !!task.bill.autopay || reshared
  const edited = () => (value === undefined ? null : editedMoney(task, { name, amount: value, due, freq: freq || null, autopay, ...(reshared ? { shared } : {}) }, newerStamp(task.updatedAt)))

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
    // what cannot be saved is not carried over: said, rather than lost without a word
    if (changed && !ready && !window.confirm('Discard your changes?')) return
    const next = ready && changed ? edited() : null
    if (next) onSave(next)
    onEditor(next ?? task)
  }

  return (
    <Modal onClose={close} className="modal narrow fin-sheet bill-form bill-edit">
      <ModalHead title={`${billEmoji(task.bill)} ${name.trim() || (saving ? 'Savings' : 'Bill')}`} variant="compose">
        <button type="button" className="btn primary" disabled={!ready} onClick={save}>
          Save
        </button>
      </ModalHead>
      <div className="modal-body">
        <label className="field">
          <span>Name</span>
          <input value={name} placeholder="e.g. Pest control" onChange={e => setName(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>{saving ? 'Set aside' : 'Amount due'}</span>
            <input className="fin-amount-input" inputMode="decimal" autoComplete="off" value={amount} placeholder="$0.00" onChange={e => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span>Next due</span>
            <input type="date" required value={due} onChange={e => setDue(e.target.value)} />
          </label>
        </div>
        {!dated && <p className="field-hint fin-sheet-hint">{due ? 'That is not a date.' : 'When it next falls due: Finance counts it from its date, and cannot without one.'}</p>}
        <div className="field-row">
          <label className="field">
            <span>Repeats</span>
            <select value={freq} onChange={e => setFreq(e.target.value as RecurrenceFreq | '')}>
              {FREQS.map(f => (
                <option key={f} value={f}>
                  {RECURRENCE_META[f]}
                </option>
              ))}
              <option value="">Once</option>
            </select>
          </label>
          <label className="field-inline fin-autopay">
            <input type="checkbox" checked={autopay} onChange={e => setAutopay(e.target.checked)} />
            <span>{saving ? 'Moved automatically' : 'Paid automatically'}</span>
          </label>
        </div>
        {inHousehold && <ShareField ownerId={task.ownerId} myId={myId} members={members} shared={shared} onChange={setShared} noun={saving ? 'goal' : 'bill'} />}
        {amount.trim() && value === undefined && <p className="warn">That is not an amount.</p>}
        <SheetActions archived={task.status === 'canceled'} onMore={more} onArchive={() => onArchive(task, task.status !== 'canceled')} onDelete={() => onDelete(task)} />
      </div>
    </Modal>
  )
}
