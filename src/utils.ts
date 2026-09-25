export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const DATETIME_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export function fmtDate(iso?: string): string {
  return iso ? DATE_FMT.format(new Date(iso)) : ''
}

export function fmtDateTime(iso?: string): string {
  return iso ? DATETIME_FMT.format(new Date(iso)) : ''
}

export function fmtTime(iso?: string): string {
  return iso ? TIME_FMT.format(new Date(iso)) : ''
}

/** Short 12-hour clock for a badge that has to fit a month cell: 9am, 5:30pm —
 *  am/pm to match the events beside it, dropping the :00 and the space to stay
 *  narrow. Shared by the calendar's work badge and the Today briefing so the
 *  same hours read the same on both. */
export function clock(iso: string): string {
  const d = new Date(iso)
  return clockAt(d.getHours(), d.getMinutes())
}

/** clock()'s words for an hour and minute of the day, with no date to read them from: 18, 0 → 6pm. */
export function clockAt(h: number, m = 0): string {
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m ? `${h12}:${String(m).padStart(2, '0')}${ampm}` : `${h12}${ampm}`
}

/**
 * How a scroll the app starts should travel: smoothly, or at once for someone
 * who has asked the system for less motion (Reduce Motion), which a CSS
 * blanket rule cannot reach — scrollIntoView takes its behaviour from here.
 */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

export function excerpt(s: string, n = 90): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/**
 * A YYYY-MM-DD day as it is said aloud — "Thursday, September 24" — for a
 * name a screen reader speaks, where the key itself reads as a string of
 * numbers. Read at local noon, so no zone can move it a day.
 */
export function spokenDay(key: string): string {
  const d = new Date(`${key}T12:00:00`)
  return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function dateKey(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  const p = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

export function toLocalInput(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fromLocalInput(v: string): string | undefined {
  return v ? new Date(v).toISOString() : undefined
}

export function humanizeDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d ${hours % 24}h`
  return `${days}d`
}

/** "5m ago". A view hands in its clock (useNow): read here as it renders, the time would stay what it was when the view first drew. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  return `${humanizeDuration(now - new Date(iso).getTime())} ago`
}
