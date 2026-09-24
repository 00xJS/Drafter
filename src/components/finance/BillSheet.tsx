import { useState } from 'react'
import { BILL_TEMPLATES, TEMPLATE_GROUPS, billFromTemplate, type BillTemplate } from '../../billtemplates'
import { localMidnightIso } from '../../itemops'
import { money } from '../../taskform'
import { RECURRENCE_META, type RecurrenceFreq, type Task } from '../../types'
import { uid } from '../../utils'
import { isDayKey } from '../../../shared/weeks.mts'
import { Modal, ModalHead } from '../Modal'
import { ShareChoice } from './ShareChoice'

// + Bill: pick what it is — rent, the electric, Netflix — and the name, the
// kind, the emoji and how often it comes round are filled in. What is left is
// what only you know: how much, and when it is next due. More options opens
// the full editor on the same bill, for anything the short form leaves out.

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
            <span>Amount</span>
            <input className="fin-amount-input" inputMode="decimal" autoComplete="off" value={amount} placeholder="$0.00" onChange={e => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span>Next due</span>
            <input type="date" value={due} onChange={e => setDue(e.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Repeats</span>
            <select value={freq} onChange={e => setFreq(e.target.value as RecurrenceFreq)}>
              {(Object.keys(RECURRENCE_META) as RecurrenceFreq[]).map(f => (
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
