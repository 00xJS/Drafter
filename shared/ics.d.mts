export interface ParsedDate {
  allDay: boolean
  ms: number
}
export interface ParsedEvent {
  uid: string
  summary?: string
  location?: string
  description?: string
  start: ParsedDate
  end?: ParsedDate
  duration?: number
  rrule?: unknown
  exdates: number[]
  recurrenceId?: number
  status?: string
  /** TRANSP:TRANSPARENT — the time is free rather than busy. */
  transparent?: boolean
}
export interface ParsedCalendar {
  calendarName?: string
  defaultTz?: string
  events: ParsedEvent[]
}
export interface EventInstance {
  id: string
  uid: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
}
export interface FeedItem {
  uid: string
  title: string
  start: number
  end?: number
  allDay: boolean
  /** All-day only: the reader's own calendar day, 'YYYY-MM-DD'. Without it the
      day is derived from `start` in UTC, which publishes an untimed task a day
      early anywhere east of UTC. */
  date?: string
  /** All-day only: last day of a multi-day event, 'YYYY-MM-DD' (inclusive). */
  endDate?: string
  /** Available time rather than busy: emits TRANSP:TRANSPARENT. */
  transparent?: boolean
  description?: string
  url?: string
  categories?: string[]
}
export declare function parseDateValue(value: string, params?: Record<string, string>, defaultTz?: string): ParsedDate | null
export declare function parseICS(text: string): ParsedCalendar
export declare function expandEvents(parsed: ParsedCalendar, fromMs: number, toMs: number): EventInstance[]
export declare function buildICS(name: string, items: FeedItem[]): string
