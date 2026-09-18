/**
 * localStorage keys the app no longer reads. Each one is a preference that used
 * to shape what the screen showed; leaving a stale value on a device would be
 * harmless only as long as nothing ever reads it again, so they are removed
 * outright on start rather than trusted to stay ignored.
 */
export const RETIRED_KEYS = [
  // the multi-project bar's filter: the app has one home project now, and a
  // saved project id would silently hide every other task after the update
  'drafter:project-filter',
  // Mine / Everyone: it narrowed by who a task was ASSIGNED to while reading
  // as though it answered who could SEE it, and now that a task says which it
  // is (v3.19) the second question has a real control of its own. A device
  // that left the switch on Mine would otherwise keep hiding the household's
  // tasks with nothing on screen to turn it off.
  'drafter:mine-only',
] as const

export function forgetRetiredKeys(): void {
  for (const key of RETIRED_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore — a browser with storage blocked has nothing to forget */
    }
  }
}
