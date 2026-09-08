export function localParts(
  date: Date | string | number,
  tz: string,
): { hour: number | null; day: string | null; weekday: string | null }

export function visibleItemsFor(
  rows: { user_id: string | null; data: unknown }[],
  userId: string,
  peerIds: Iterable<string> | undefined,
  ownerId: string | null,
): unknown[]

export function buildDigest(
  items: unknown[],
  tz: string,
  now: Date,
  nudged?: Record<string, string>,
): {
  overdue: { id: string; title?: string }[]
  dueToday: { id: string; title?: string }[]
  occasions: string[]
  peopleDue: string[]
  lines: string[]
  nudgedNext: Record<string, string>
}
