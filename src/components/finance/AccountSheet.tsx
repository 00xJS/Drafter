import { useId, useState } from 'react'
import { formatMoney } from '../../bills'
import { accountFromForm, accountKindLabel, isLiability, kindLabel, kindOf, kindParts, latestBalance, parseBalance, withBalance, withKind, type AccountKind } from '../../finance'
import { newerStamp } from '../../itemops'
import type { Account } from '../../types'
import { uid } from '../../utils'
import { ConfirmButton } from '../ConfirmButton'
import { Modal, ModalHead } from '../Modal'
import { Segmented } from '../stats/Segmented'
import { KindMark } from './KindMark'
import { KindPicker, NAME_EXAMPLES, PickedKind } from './KindPicker'
import { shortDay } from './labels'

// An account's sheet: what it is called, what kind it is, whose it is, what
// it holds today, and the last few balances typed in. It replaces the old
// tap-the-name rename, which nobody found, and it is where an account is
// added from Manage: its kind first, then a name, which it will not add
// without — an account is never called after its kind.

type Member = { id: string; displayName: string }

interface Props {
  /** The account to edit; none to add one. */
  account?: Account
  members: Member[]
  /** Today's key: the day a balance typed here is for. */
  today: string
  /** Written with an Undo: `before` is null for one added. */
  onSave(before: Account | null, after: Account, message: string): void
  onRemove(id: string): void
  onClose(): void
}

/** How many check-ins the sheet lists, newest first. */
const HISTORY = 5

export function AccountSheet({ account, members, today, onSave, onRemove, onClose }: Props) {
  const ids = useId()
  const [kind, setKind] = useState<AccountKind | null>(() => (account ? kindOf(account) : null))
  const [name, setName] = useState(account?.name ?? '')
  const [whose, setWhose] = useState(account?.memberId ?? '')
  const [typed, setTyped] = useState('')

  const balance = parseBalance(typed)
  const unread = !!typed.trim() && balance === null
  const owes = kind ? kindParts(kind).type === 'credit' : !!account && isLiability(account)
  const changed = account ? name.trim() !== account.name || kind !== kindOf(account) || whose !== (account.memberId ?? '') || balance !== null : !!name.trim() || !!typed.trim()
  // a kind to add one as; an investment written before holdings can be saved without one
  const ready = !!name.trim() && !unread && (!!account || !!kind)

  const close = () => {
    if (changed && !window.confirm(account ? 'Discard your changes?' : 'Discard this account?')) return
    onClose()
  }

  /** The account as the sheet has it now, stamped newer than the one it was opened on. */
  const edited = (a: Account): Account => {
    let next: Account = { ...a, name: name.trim() || a.name }
    if (kind && kind !== kindOf(a)) next = withKind(next, kind)
    const { memberId: _was, ...rest } = next
    next = whose ? { ...rest, memberId: whose } : rest
    if (balance !== null) next = withBalance(next, isLiability(next) ? Math.abs(balance) : balance, today)
    return { ...next, updatedAt: newerStamp(a.updatedAt) }
  }

  const save = () => {
    if (!ready) return
    if (!account) {
      if (!kind) return
      const now = new Date().toISOString()
      const added = accountFromForm({ kind, name, memberId: whose || undefined, balance: balance ?? undefined }, { id: uid(), now, today })
      if (added) onSave(null, added, `Added “${added.name}”`)
      return
    }
    if (!changed) return onClose()
    const next = edited(account)
    onSave(account, next, balance !== null ? `Checked in “${next.name}”` : `Saved “${next.name}”`)
  }

  const archive = () => {
    if (!account) return
    const base = ready && changed ? edited(account) : { ...account, updatedAt: newerStamp(account.updatedAt) }
    if (account.archivedAt) {
      const { archivedAt: _was, ...open } = base
      onSave(account, open, `Unarchived “${base.name}”`)
    } else {
      onSave(account, { ...base, archivedAt: new Date().toISOString() }, `Archived “${base.name}”`)
    }
  }

  const whoseField = members.length > 1 && (
    <div className="field">
      <span>Whose</span>
      <Segmented items={[{ key: '', label: 'Shared' }, ...members.map(m => ({ key: m.id, label: m.displayName }))]} value={whose} onChange={setWhose} label="Whose account" role="group" />
    </div>
  )

  const balanceField = (
    <label className="field">
      <span>{owes ? 'Owed today' : 'Balance today'}</span>
      <input
        className="fin-amount-input"
        inputMode="decimal"
        autoComplete="off"
        value={typed}
        placeholder={account ? 'Leave blank to keep it' : 'Optional'}
        aria-invalid={unread || undefined}
        onChange={e => setTyped(e.target.value)}
      />
      {unread && <small className="warn">That is not an amount.</small>}
    </label>
  )

  // adding, and nothing picked yet: the kinds, as a grid
  if (!account && !kind) {
    return (
      <Modal onClose={onClose} className="modal narrow fin-sheet account-sheet">
        <ModalHead title="Add an account" />
        <div className="modal-body">
          <p className="field-hint fin-sheet-hint">What kind is it? Drafter never connects to a bank — you type in what each one holds.</p>
          <KindPicker value={null} onPick={setKind} />
        </div>
      </Modal>
    )
  }

  const latest = account ? latestBalance(account) : null
  const history = account ? account.balances.slice(-HISTORY - 1) : []
  return (
    <Modal onClose={close} className="modal narrow fin-sheet account-sheet">
      <ModalHead
        title={
          <>
            <KindMark kind={kind} /> {name.trim() || (kind ? kindLabel(kind) : (account?.name ?? ''))}
          </>
        }
        variant="compose"
      >
        <button type="button" className="btn primary" disabled={!ready} onClick={save}>
          {account ? 'Save' : 'Add'}
        </button>
      </ModalHead>
      <div className="modal-body">
        {!account && kind && <PickedKind kind={kind} onChange={() => setKind(null)} />}
        <div className="field">
          <span id={`${ids}-name`}>Name</span>
          <input
            value={name}
            required
            aria-labelledby={`${ids}-name`}
            aria-describedby={name.trim() ? undefined : `${ids}-name-hint`}
            placeholder={kind ? `e.g. ${NAME_EXAMPLES[kind]}` : 'Name'}
            autoComplete="off"
            onChange={e => setName(e.target.value)}
          />
          {!name.trim() && <small id={`${ids}-name-hint`}>The name you know it by — the bank, the app, or what it is for.</small>}
        </div>
        {account && (
          <div className="field">
            <span>Kind</span>
            <KindPicker value={kind} onPick={setKind} label="Kind of account" />
            {!kind && <small>{accountKindLabel(account)} — pick what it holds, so it can be told apart from the others.</small>}
          </div>
        )}
        {whoseField}
        {balanceField}
        {account && (
          <div className="field fin-history">
            <span>Balances</span>
            {latest ? (
              <ul className="fin-history-list">
                {history
                  .map((b, i) => ({ b, move: i > 0 ? Math.round((b.amount - history[i - 1].amount) * 100) / 100 : null }))
                  .slice(history.length > HISTORY ? 1 : 0)
                  .reverse()
                  .map(({ b, move }) => (
                    <li key={b.on}>
                      <span>{b.on === today ? 'Today' : shortDay(b.on)}</span>
                      {move !== null && move !== 0 && (
                        <small className={(move < 0) !== isLiability(account) ? 'fin-move worse' : 'fin-move better'}>
                          {move < 0 ? '↓' : '↑'} {formatMoney(Math.abs(move))}
                        </small>
                      )}
                      <strong className={isLiability(account) ? 'owed' : undefined}>{formatMoney(b.amount)}</strong>
                    </li>
                  ))}
              </ul>
            ) : (
              <small>Nothing typed in yet.</small>
            )}
            {latest && <small>Last checked in {latest.on === today ? 'today' : `on ${shortDay(latest.on)}`}.</small>}
          </div>
        )}
        {account && (
          <div className="fin-sheet-actions">
            <button type="button" className="btn subtle" onClick={archive}>
              {account.archivedAt ? 'Unarchive' : 'Archive'}
            </button>
            <ConfirmButton className="btn subtle danger" confirmLabel="Delete it?" onConfirm={() => onRemove(account.id)}>
              Delete
            </ConfirmButton>
          </div>
        )}
        {account && <p className="field-hint fin-sheet-hint">{account.archivedAt ? 'Archived: kept, and left out of every total.' : 'Archive one you have closed: it keeps its history and leaves the totals.'}</p>}
      </div>
    </Modal>
  )
}
