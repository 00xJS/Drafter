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

export function excerpt(s: string, n = 90): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
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

export function timeAgo(iso: string): string {
  return `${humanizeDuration(Date.now() - new Date(iso).getTime())} ago`
}

export function timeUntil(iso: string): string {
  return `in ${humanizeDuration(new Date(iso).getTime() - Date.now())}`
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
