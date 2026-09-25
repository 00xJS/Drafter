import { useEffect, useRef, useState } from 'react'
import { formatMoney } from '../../bills'
import { accountFromForm, isLiability, latestBalance, parseBalance, withBalance, type AccountKind } from '../../finance'
import { newerStamp } from '../../itemops'
import type { Account } from '../../types'
import { uid } from '../../utils'
import { Modal, ModalHead } from '../Modal'
import { AccountMark } from './KindMark'
import { KindPicker, NAME_EXAMPLES, PickedKind } from './KindPicker'
import { ageOf } from './labels'

// Check in: every account at once, what each holds today. It is the whole of
// Finance's contact with the money itself — Drafter never connects to a bank —
// so it is one sheet, one Save and one toast rather than an account at a time.
// A card is typed as what is owed on it, a positive number, as its balance
// has always been kept (types.ts BalanceCheck).
//
// An account added here is picked by its kind first, then named: it will not
// add one without a name, so none is ever called after its kind.

/** One account written by a check-in: as it was (null for one added here), and as it is now. */
export interface CheckInChange {
  before: Account | null
  after: Account
}

interface Props {
  /** The accounts that count: live, not closed. */
  accounts: Account[]
  /** Opened on one account (a tile's tap), or on adding one. */
  focus?: string | 'add'
  /** Today's key: the day every balance typed here is for. */
  today: string
  onSave(changes: CheckInChange[]): void
  onClose(): void
}

export function CheckInSheet({ accounts, focus, today, onSave, onClose }: Props) {
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [added, setAdded] = useState<Account[]>([])
  const [adding, setAdding] = useState(() => focus === 'add' || accounts.length === 0)
  const [kind, setKind] = useState<AccountKind | null>(null)
  const [name, setName] = useState('')
  // a field is focused for the keyboard only where a keyboard is: on a phone a
  // focus raises the keyboard over the very field it went to
  const [fine] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches)
  const focusRow = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    focusRow.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  const rows = [...accounts, ...added]
  const entered = rows.flatMap(a => {
    const n = parseBalance(typed[a.id] ?? '')
    return n === null ? [] : [{ account: a, amount: isLiability(a) ? Math.abs(n) : n }]
  })
  const unread = rows.filter(a => (typed[a.id] ?? '').trim() && parseBalance(typed[a.id]) === null)
  const changed = entered.length > 0 || added.length > 0

  const close = () => {
    if (changed && !window.confirm('Discard what you typed?')) return
    onClose()
  }

  const addAccount = () => {
    // stamped when the check-in is saved, with the rest
    const account = kind && accountFromForm({ kind, name }, { id: uid(), now: '', today })
    if (!account) return
    setAdded(list => [...list, account])
    setName('')
    setKind(null)
    setAdding(false)
  }

  const save = () => {
    const now = new Date().toISOString()
    const isNew = (a: Account) => added.some(x => x.id === a.id)
    const changes: CheckInChange[] = entered.map(({ account, amount }) => ({
      before: isNew(account) ? null : account,
      after: { ...withBalance(account, amount, today), ...(isNew(account) ? { createdAt: now, updatedAt: now } : { updatedAt: newerStamp(account.updatedAt) }) },
    }))
    // one added and left blank is still added: its balance can wait for next time
    for (const a of added) if (!entered.some(e => e.account.id === a.id)) changes.push({ before: null, after: { ...a, createdAt: now, updatedAt: now } })
    onSave(changes)
  }

  return (
    <Modal onClose={close} className="modal narrow fin-sheet checkin-sheet">
      <ModalHead title="Check in" variant="compose">
        <button type="button" className="btn primary" disabled={!changed || unread.length > 0} onClick={save}>
          Save
        </button>
      </ModalHead>
      <div className="modal-body">
        <p className="field-hint fin-sheet-hint">What each account holds today; for a card, what you owe on it. Drafter never connects to a bank — this is your own note of it.</p>
        {rows.length > 0 && (
          <ul className="checkin-list">
            {rows.map(a => {
              const latest = latestBalance(a)
              const owed = isLiability(a)
              const bad = unread.includes(a)
              return (
                <li key={a.id} ref={a.id === focus ? focusRow : undefined} className={a.id === focus ? 'checkin-row focus' : 'checkin-row'}>
                  <label className="checkin-field">
                    <span className="checkin-name">
                      <span aria-hidden="true">
                        <AccountMark account={a} />
                      </span> {a.name}
                    </span>
                    <small className="muted">{latest ? `${formatMoney(latest.amount)}${owed ? ' owed' : ''} · ${ageOf(latest.on, today)}` : 'Nothing typed in yet'}</small>
                    <input
                      className="fin-amount-input"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={owed ? 'Owed today' : 'Balance today'}
                      aria-label={`${a.name}: ${owed ? 'owed' : 'balance'} today`}
                      aria-invalid={bad || undefined}
                      autoFocus={fine && a.id === focus}
                      value={typed[a.id] ?? ''}
                      onChange={e => setTyped(t => ({ ...t, [a.id]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && changed && !unread.length && save()}
                    />
                  </label>
                  {bad && <small className="warn">That is not an amount.</small>}
                </li>
              )
            })}
          </ul>
        )}
        {adding ? (
          <div className="checkin-add" role="group" aria-label="Add an account">
            {kind ? (
              <>
                <PickedKind kind={kind} onChange={() => setKind(null)} />
                <input
                  value={name}
                  required
                  placeholder={`Name, e.g. ${NAME_EXAMPLES[kind]}`}
                  aria-label="Account name"
                  autoComplete="off"
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addAccount()}
                />
                <button type="button" className="btn" disabled={!name.trim()} onClick={addAccount}>
                  Add
                </button>
              </>
            ) : (
              <>
                <span className="checkin-add-ask">What kind of account?</span>
                <KindPicker value={null} onPick={setKind} />
              </>
            )}
          </div>
        ) : (
          <button type="button" className="btn subtle checkin-add-open" onClick={() => setAdding(true)}>
            + Account
          </button>
        )}
      </div>
    </Modal>
  )
}
