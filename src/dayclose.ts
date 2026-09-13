// "Day closed": this device's own note that Shut down has run today. It lives
// here rather than in ShutdownSheet so Today's strip (in the first load) and
// the planner's apply/Undo can read and write it without pulling the sheet's
// chunk in with them. localStorage only — never synced: another device may
// not have shut down.

const CLOSED_PREFIX = 'drafter:shutdown:'
/** "Day closed" is this device's own note, never synced: another device may not have shut down. */
export const shutdownKey = (day: string): string => `${CLOSED_PREFIX}${day}`

export function dayClosed(day: string): boolean {
  try {
    return localStorage.getItem(shutdownKey(day)) === '1'
  } catch {
    return false
  }
}

/** Mark `day` closed, forgetting any earlier day's mark while we are here. */
export function closeDay(day: string): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith(CLOSED_PREFIX) && key !== shutdownKey(day)) localStorage.removeItem(key)
    }
    localStorage.setItem(shutdownKey(day), '1')
  } catch {}
}

/** Undo of a shut-down: the strip offers Shut down again. */
export function reopenDay(day: string): void {
  try {
    localStorage.removeItem(shutdownKey(day))
  } catch {}
}
