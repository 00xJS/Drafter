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
