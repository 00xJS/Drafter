import { flushPendingMedia, unsentPhotoCount } from './media'

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

/** The media store's count and flush around a sign-out. A count that can't be read reads as none: the way out is never locked. */
export function withMedia(signOut: () => Promise<void>): SignOutSteps {
  return { unsent: () => unsentPhotoCount().catch(() => 0), flush: () => flushPendingMedia(), signOut }
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

/** "Try uploading now": send them, and carry on signing out once every one is up; otherwise the question again, with what is left. */
export async function uploadThenSignOut(steps: SignOutSteps): Promise<UnsentAsk | null> {
  await steps.flush().catch(() => {})
  const count = await steps.unsent()
  if (count === 0) {
    await steps.signOut()
    return null
  }
  return { count, tried: true }
}

/** The question, in words. */
export function unsentLine(count: number): string {
  return count === 1
    ? '1 photo hasn’t uploaded yet. Signing out deletes it from this device.'
    : `${count} photos haven’t uploaded yet. Signing out deletes them from this device.`
}
