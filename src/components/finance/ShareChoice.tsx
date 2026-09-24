import { Segmented } from '../stats/Segmented'

const CHOICES = [
  { key: 'shared', label: '👥 Shared' },
  { key: 'private', label: '🔒 Private' },
] as const

/**
 * Who can see a bill or a goal added from Finance, in a household. It starts
 * on Shared: Finance is the household's picture — its accounts are always both
 * members' — and a rent only one of you can see leaves the other's "safe to
 * spend" wrong. The same choice the task editor offers, and it can be changed
 * there too.
 */
export function ShareChoice({ shared, onChange, noun }: { shared: boolean; onChange(shared: boolean): void; noun: string }) {
  return (
    <div className="field">
      <span>Who can see it</span>
      <Segmented items={CHOICES} value={shared ? 'shared' : 'private'} onChange={k => onChange(k === 'shared')} label="Who can see it" role="group" />
      <small className="muted">{shared ? `Everyone in your household sees this ${noun} in Finance.` : `Only you can see this ${noun}; it is left out of the other’s Finance.`}</small>
    </div>
  )
}
