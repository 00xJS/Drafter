import { daysBetween, STALE_DAYS } from '../../finance'
import type { RecurrenceFreq, Task } from '../../types'

// How Finance says a day, a cadence and a name. Dates follow the device, as
// every date in the app does; money is formatMoney's alone (en-US dollars).

/** Noon on a YYYY-MM-DD day, so no zone or clock change can tip it onto the next. */
const noon = (key: string) => new Date(`${key}T12:00`)

/** "Fri, Sep 26" */
export const dayLabel = (key: string) => noon(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
/** "Sep 26" */
export const shortDay = (key: string) => noon(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
/** The two halves of a date chip: "Fri" over "26". */
export const chipOf = (key: string) => ({ weekday: noon(key).toLocaleDateString(undefined, { weekday: 'short' }), day: String(noon(key).getDate()) })

/** Sunday first, the week as the device names it: the check-in's day picker. */
export const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 20 + i, 12).toLocaleDateString(undefined, { weekday: 'long' }))

/** "$200 a month", "$50 every 2 weeks": how often a set-aside comes round, after its amount. */
export const PER: Record<RecurrenceFreq, string> = {
  daily: 'a day',
  weekly: 'a week',
  biweekly: 'every 2 weeks',
  monthly: 'a month',
  quarterly: 'every 3 months',
  yearly: 'a year',
}

/** How old a balance is: "today", "2d", or "as of Sep 16" once it is a week old. */
export function ageOf(on: string, today: string): string {
  const days = daysBetween(on, today)
  if (days <= 0) return 'today'
  if (days < STALE_DAYS) return `${days}d`
  return `as of ${shortDay(on)}`
}

/**
 * What a row is called. A payday is whose it is: "Maria’s pay", when the
 * title is the one + Payday gave it, and the title with her name beside it
 * otherwise (the row's meta line says whose).
 */
export function moneyName(t: Task, whose: string | null): string {
  const title = t.title.trim()
  if (t.bill?.kind === 'income' && whose && (!title || title === 'Payday')) return `${whose}’s pay`
  return title || (t.bill?.kind === 'income' ? 'Payday' : t.bill?.kind === 'saving' ? 'Savings' : 'Untitled bill')
}
