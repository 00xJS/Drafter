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
  /** The reader: their focus for today opens the digest; a household member's picks are left out. */
  userId?: string | null,
  /** `weekPlan`: Sunday's week-plan summary (weekPlanSummary), which closes the digest as "Plan next week: …". */
  extra?: { weekPlan?: string | null },
): {
  overdue: { id: string; title?: string }[]
  dueToday: { id: string; title?: string }[]
  occasions: string[]
  peopleDue: string[]
  /** Cadence places that are overdue a return, "Nopi (120d)"; never a place without a rhythm. */
  placesDue: string[]
  /** "Tonight: Pasta (7 ingredients)" when a dinner is planned today. */
  tonight: string | null
  /** Today's open focus tasks, the first line's names. */
  focus: { id: string; title?: string }[]
  weekPlan: string | null
  lines: string[]
  nudgedNext: Record<string, string>
}
