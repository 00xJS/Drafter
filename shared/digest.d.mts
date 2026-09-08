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
  /** Cadence places that are overdue a return, "Nopi (120d)"; never a place without a rhythm. */
  placesDue: string[]
  /** "Tonight: Pasta (7 ingredients)" when a dinner is planned today. */
  tonight: string | null
  lines: string[]
  nudgedNext: Record<string, string>
}
