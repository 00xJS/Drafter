import { ACCOUNT_KINDS, kindLabel, kindName, type AccountKind } from '../../finance'
import { KindMark } from './KindMark'

// What kind of account: the nine as one grid, money to spend first and what
// is invested last. Picked before the name, so the name field can suggest
// one of its kind ("Fidelity 401(k)") — and so no account is ever called by
// its kind, which is how two investments both came to be "Investment".

/** The name field's example for each kind. */
export const NAME_EXAMPLES: Record<AccountKind, string> = {
  checking: 'Chase checking',
  savings: 'Ally savings',
  cash: 'Wallet',
  credit: 'Amex Gold',
  stocks: 'Vanguard brokerage',
  retirement: 'Fidelity 401(k)',
  crypto: 'Coinbase',
  hsa: 'HealthEquity HSA',
  other: 'I bonds',
}

export function KindPicker({ value, onPick, label = 'What kind of account' }: { value: AccountKind | null; onPick(kind: AccountKind): void; label?: string }) {
  return (
    <div className="fin-kinds" role="radiogroup" aria-label={label}>
      {ACCOUNT_KINDS.map(kind => (
        <button key={kind} type="button" role="radio" aria-checked={value === kind} className={value === kind ? 'fin-kind on' : 'fin-kind'} onClick={() => onPick(kind)}>
          <span className="fin-kind-emoji" aria-hidden="true">
            <KindMark kind={kind} />
          </span>
          <span className="fin-kind-name">{kindLabel(kind)}</span>
        </button>
      ))}
    </div>
  )
}

/** The kind picked, said in full, with the way back to the grid: the line above the name while one is added. */
export function PickedKind({ kind, onChange }: { kind: AccountKind; onChange(): void }) {
  return (
    <div className="fin-kind-picked">
      <span>
        <span aria-hidden="true"><KindMark kind={kind} /></span> {kindName(kind)}
      </span>
      <button type="button" className="btn subtle" onClick={onChange} aria-label={`Change the kind: ${kindLabel(kind)}`}>
        Change
      </button>
    </div>
  )
}
