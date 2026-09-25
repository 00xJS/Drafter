import { Modal, ModalHead } from '../Modal'

// The one + on Finance's main view: what it can add, each opening its own
// short sheet. It took the place of a row of four buttons that sat between
// safe to spend and the pay periods, and read as much as either of them.

export type AddChoice = 'bill' | 'payday' | 'goal' | 'checkin'

const CHOICES: { key: AddChoice; emoji: string; label: string; hint: string }[] = [
  { key: 'bill', emoji: '🧾', label: 'Bill', hint: 'Rent, power, a card, a subscription' },
  { key: 'payday', emoji: '💵', label: 'Payday', hint: 'Take-home pay, and how often it lands' },
  { key: 'goal', emoji: '🎯', label: 'Goal', hint: 'Something to save towards' },
  { key: 'checkin', emoji: '🏦', label: 'Check in', hint: 'What each account holds today' },
]

export function AddSheet({ onPick, onClose }: { onPick(choice: AddChoice): void; onClose(): void }) {
  return (
    <Modal onClose={onClose} className="modal narrow fin-sheet fin-add-sheet">
      <ModalHead title="Add to Finance" />
      <div className="modal-body">
        <ul className="fin-add-list">
          {CHOICES.map(c => (
            <li key={c.key}>
              <button type="button" className="fin-add-choice" onClick={() => onPick(c.key)}>
                <span className="fin-add-emoji" aria-hidden="true">
                  {c.emoji}
                </span>
                <span className="fin-add-copy">
                  <strong>{c.label}</strong>
                  <small>{c.hint}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
