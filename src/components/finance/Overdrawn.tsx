/**
 * The minus an iPhone's amount keypad does not have. A balance is typed on the
 * decimal keypad, which has digits and a point and nothing else, so a checking
 * account that had gone below zero could not be typed on the phone at all.
 * Pressed, the amount beside it is overdrawn (signedBalance in finance.ts).
 * Only beside an account that can be overdrawn: a card's balance is what is
 * owed on it, and always a positive number.
 */
export function OverdrawnToggle({ on, onChange, account }: { on: boolean; onChange(on: boolean): void; account: string }) {
  return (
    <button
      type="button"
      className={on ? 'btn subtle fin-overdrawn on' : 'btn subtle fin-overdrawn'}
      aria-pressed={on}
      aria-label={account ? `${account}: Overdrawn` : 'Overdrawn'}
      // the amount field keeps the caret, and the phone its keyboard
      onMouseDown={e => e.preventDefault()}
      onClick={() => onChange(!on)}
    >
      <span aria-hidden="true">−</span> Overdrawn
    </button>
  )
}
