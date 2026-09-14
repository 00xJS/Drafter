import { flushPendingMedia, unsentPhotoCount } from './media'
import { syncIfStarted } from './store'

// Signing out wipes this device — clearLocalData deletes the whole IndexedDB —
// and a photo still waiting to upload lives nowhere else yet: a piece of
// clothing's, a note's or a task's. So a sign-out the person starts asks first
// while one is waiting (SignOutGuard.tsx draws the question). A session that
// ends by itself (revoked, or signed out on another device) has no one to ask
// and no session left to upload with.

/** The question to ask before signing out: how many photos are waiting, and whether an upload was just tried. */
export interface UnsentAsk {
  count: number
  tried: boolean
}

/** What a sign-out is made of, handed in so the tests need no IndexedDB, bucket or session. */
export interface SignOutSteps {
  /** Photos not in the bucket yet. */
  unsent(): Promise<number>
  /** Send what is waiting, now. */
  flush(): Promise<unknown>
  /** The sign-out itself: the session dropped, this device wiped, the page reloaded. */
  signOut(): Promise<void>
}

/** How long Try uploading now waits on the uploads before it asks again with what is left; they carry on either way. */
export const UPLOAD_WAIT_MS = 20_000

/**
 * The media store's count and flush around a sign-out. The flush sends the
 * edits waiting to sync as well: the wipe would take them too, and with them
 * a piece that points at a photo just sent. A count that can't be read reads
 * as none: the way out is never locked.
 */
export function withMedia(signOut: () => Promise<void>): SignOutSteps {
  return {
    unsent: () => unsentPhotoCount().catch(() => 0),
    flush: () => Promise.allSettled([flushPendingMedia(), syncIfStarted()]),
    signOut,
  }
}

/** The first tap: sign out at once when nothing is waiting; otherwise do nothing yet and return the question. */
export async function startSignOut(steps: SignOutSteps): Promise<UnsentAsk | null> {
  const count = await steps.unsent()
  if (count === 0) {
    await steps.signOut()
    return null
  }
  return { count, tried: false }
}

/** Settles once `work` has, or once `ms` have passed: a stalled upload never holds the question. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    void work
      .catch(() => {})
      .then(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}

/**
 * "Try uploading now": send them, and carry on signing out once every one is
 * up; otherwise the question again, with what is left. It waits UPLOAD_WAIT_MS
 * at most, and a Cancel meanwhile (`signal`) signs nobody out: the uploads
 * carry on behind it.
 */
export async function uploadThenSignOut(steps: SignOutSteps, signal?: AbortSignal): Promise<UnsentAsk | null> {
  await within(steps.flush(), UPLOAD_WAIT_MS)
  const count = await steps.unsent()
  if (signal?.aborted) return null
  if (count === 0) {
    await steps.signOut()
    return null
  }
  return { count, tried: true }
}

/** "Sign out anyway". */
export async function signOutAnyway(steps: SignOutSteps): Promise<null> {
  await steps.signOut()
  return null
}

/** What is under way: the count at the first tap, an upload being tried, or the sign-out itself. */
export type SignOutBusy = 'checking' | 'uploading' | 'signing-out'

/** One answer, run against the steps; `signal` says it was cancelled. */
export type SignOutStep = (steps: SignOutSteps, signal: AbortSignal) => Promise<UnsentAsk | null>

/**
 * The answers' bookkeeping, apart from React (useSignOut keeps one per
 * button): one answer runs at a time, and Cancel ends the one under way at
 * once, so an upload that finishes later neither reopens the question nor
 * signs out, and the next tap needn't wait for it.
 */
export function signOutFlow(steps: () => SignOutSteps, show: { ask(ask: UnsentAsk | null): void; busy(busy: SignOutBusy | null): void }) {
  let turn: AbortController | null = null
  return {
    run(phase: SignOutBusy, step: SignOutStep): Promise<void> {
      if (turn) return Promise.resolve()
      const mine = new AbortController()
      turn = mine
      show.busy(phase)
      return step(steps(), mine.signal)
        .then(
          next => {
            if (!mine.signal.aborted) show.ask(next)
          },
          () => {},
        )
        .finally(() => {
          if (turn !== mine) return
          turn = null
          show.busy(null)
        })
    },
    cancel(): void {
      turn?.abort()
      turn = null
      show.ask(null)
      show.busy(null)
    },
  }
}

/** The question, in words. */
export function unsentLine(count: number): string {
  return count === 1
    ? '1 photo hasn’t uploaded yet. Signing out deletes it from this device.'
    : `${count} photos haven’t uploaded yet. Signing out deletes them from this device.`
}

/** With the session expired nothing can upload, so there is nothing to try: what Cancel does instead. */
export function expiredLine(count: number): string {
  return count === 1
    ? 'Your session has expired, so it can’t be uploaded first. Cancel keeps it on this device for now.'
    : 'Your session has expired, so they can’t be uploaded first. Cancel keeps them on this device for now.'
}
