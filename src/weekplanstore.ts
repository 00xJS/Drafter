// Where Plan next week remembers the rows said no to for a week, so its next
// proposal for that week leaves them out. A module of its own so the shell can
// read it without pulling the sheet out of its chunk (lazyload.test.ts).

/** The localStorage key for one week's dismissed rows. */
export const weekPlanDismissedKey = (weekKey: string) => `drafter:weekplan-dismissed:${weekKey}`

export function readWeekPlanDismissed(weekKey: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(weekPlanDismissedKey(weekKey)) ?? '[]')
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

/** Add to a week's dismissed rows (never replace them). */
export function rememberWeekPlanDismissed(weekKey: string, keys: readonly string[]): void {
  if (keys.length === 0) return
  try {
    const next = [...new Set([...readWeekPlanDismissed(weekKey), ...keys])].slice(-200)
    localStorage.setItem(weekPlanDismissedKey(weekKey), JSON.stringify(next))
  } catch {
    /* private mode: they come back next time, which is harmless */
  }
}
