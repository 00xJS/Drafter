export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const DATETIME_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function fmtDate(iso?: string): string {
  return iso ? DATE_FMT.format(new Date(iso)) : ''
}

export function fmtDateTime(iso?: string): string {
  return iso ? DATETIME_FMT.format(new Date(iso)) : ''
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

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
