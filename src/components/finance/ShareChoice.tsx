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

/**
 * Who can see one already written. Its owner has the choice; anyone else is
 * told whose it is, because only the owner can keep a task back and the
 * database refuses anyone else's try (the task editor's AssignFields says the
 * same, the same way).
 */
export function ShareField({
  ownerId,
  myId,
  members,
  shared,
  onChange,
  noun,
}: {
  ownerId?: string
  myId?: string | null
  members: readonly { id: string; displayName: string }[]
  shared: boolean
  onChange(shared: boolean): void
  noun: string
}) {
  if (!ownerId || !myId || ownerId === myId) return <ShareChoice shared={shared} onChange={onChange} noun={noun} />
  const owner = members.find(m => m.id === ownerId)?.displayName
  return (
    <div className="field">
      <span>Who can see it</span>
      <small className="muted">
        <span aria-hidden="true">👥</span> {owner ? `${owner}’s ${noun}` : `Someone else’s ${noun}`} — only {owner ?? 'they'} can keep it to themselves.
      </small>
    </div>
  )
}
