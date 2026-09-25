import type { ReactNode } from 'react'
import { dateKey } from '../../utils'
import { dayLabel } from './labels'

/**
 * "Next: Fri, Sep 25" at the head of a bill's or a payday's row, or "No date
 * yet" in the warning ink. First on the line, so a long payee cannot push it
 * off the end on a phone: a payday with no date is one Finance cannot count,
 * and that used to be exactly what a row left unsaid.
 */
export function NextDate({ dueAt }: { dueAt?: string }) {
  const at = dueAt ? new Date(dueAt) : null
  return at && !Number.isNaN(at.getTime()) ? <span className="fin-next">Next: {dayLabel(dateKey(at))}</span> : <span className="fin-next fin-nodate">No date yet</span>
}

/**
 * A money row's second line: its date, whole, then the rest (whose, who is
 * paid, how often), which is what gives way when the line is short. On a
 * phone the rest takes a line of its own rather than being cut to a dot or two.
 */
export function MoneyMeta({ when, rest }: { when: ReactNode; rest: string }) {
  return (
    <small className="fin-meta">
      {when}
      {rest && (
        <span className="fin-meta-rest">
          <span className="fin-meta-dot"> · </span>
          {rest}
        </span>
      )}
    </small>
  )
}
