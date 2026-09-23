import type { SyncInfo } from './syncengine'
import type { SyncFailure } from './syncstate'

// One syncing tab. Every tab of the web app used to run its own sync engine
// over the one IndexedDB cache and the one set of sync bookkeeping, with
// nothing between them: a tab back from the background pulled from the cursor
// another tab had already moved, missed the partner's rename that tab had
// pulled, and its next edit of the record wrote the old title back over it.
// And the tabs wrote their dirty sets and journals over each other's.
//
// Now one tab leads — the one holding the Web Lock below — and only it runs
// rounds and writes the cache and its bookkeeping. Every other tab follows:
// it reads the records the leader wrote when told to (BroadcastChannel), and
// hands its own edits to the leader through IndexedDB (src/syncengine.ts).
// A tab out of view gives the lead to one in view that is waiting for it, as
// a hidden page does not run the periodic round; a tab that closes lets go of
// the lock with it, and the next one waiting takes over.
//
// The iOS shell is one page and needs none of this, and a browser without
// Web Locks keeps the old behaviour: every page leads.

/** What the tabs tell each other. `from` is the sender's tab id. */
export type SyncMessage =
  /** The leader's write landed: re-read these records. `taken`: the hand-overs (their hids) it took in. */
  | { type: 'wrote'; from: string; seq: number; upserts: string[]; deletes: string[]; taken: string[] }
  /** The leader's sync status, for the pill and Settings of every other tab. */
  | { type: 'status'; from: string; syncInfo: SyncInfo; failures: SyncFailure[] }
  /** A follower wrote edits to the outbox. */
  | { type: 'handoff'; from: string }
  /** A follower asks the leader to act (Sync now, Full resync, Try again…) and waits for the answer. */
  | { type: 'ask'; from: string; rid: string; op: AskOp; arg?: string }
  | { type: 'answer'; from: string; rid: string; ok: boolean }
  /** A tab in view wants the lead: a leader out of view gives it up. Also asks the leader for its status. */
  | { type: 'want'; from: string }
  /** A tab that just opened, following: the leader says where sync stands. */
  | { type: 'hello'; from: string }

/** What a follower asks the leader to do; `arg` is the record id (the ids, one per line, for purge; the account for retainMine). */
export type AskOp = 'sync' | 'full' | 'retry' | 'discard' | 'retainMine' | 'purge'

export interface Leadership {
  /** This tab's id, as its messages carry it. */
  readonly id: string
  /** Settles once this tab knows whether it leads at start: at once when no other tab does. */
  ready: Promise<void>
  leading(): boolean
  /** This tab came into view (true) or left it: in view it waits for the lead, out of view it stops waiting. */
  setVisible(visible: boolean): void
  /** Whether another tab in view is waiting for the lead. */
  othersWaiting(): Promise<boolean>
  /** Give the lead up: the next tab waiting takes it. */
  release(): void
  /** Called when this tab starts or stops leading. Returns the unsubscribe. */
  onLeadChange(cb: (leading: boolean) => void): () => void
  post(msg: SyncMessage): void
  onMessage(cb: (msg: SyncMessage) => void): () => void
}

export const LOCK_NAME = 'drafter-sync'
export const CHANNEL_NAME = 'drafter-sync'

interface Locks {
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (lock: unknown) => Promise<void> | void): Promise<unknown>
  query?(): Promise<{ held?: { name?: string; clientId?: string }[]; pending?: { name?: string; clientId?: string }[] }>
}

interface Channel {
  postMessage(msg: unknown): void
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
}

export interface LeadershipEnv {
  locks: Locks
  channel: Channel
  /** Whether the page is in view right now. */
  visible(): boolean
  id?: string
}

/**
 * The browser's own: null in the iOS shell (one page, nothing to agree with),
 * outside a page (Node has Web Locks too, and no tabs), and wherever Web Locks
 * or BroadcastChannel are missing — every page leads there, as before.
 */
export function browserLeadership(native: boolean): Leadership | null {
  if (native || typeof document === 'undefined' || typeof navigator === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  const locks = (navigator as Navigator & { locks?: Locks }).locks
  if (!locks || typeof locks.request !== 'function') return null
  try {
    return createLeadership({ locks, channel: new BroadcastChannel(CHANNEL_NAME), visible: () => document.visibilityState !== 'hidden' })
  } catch {
    return null
  }
}

export function createLeadership(env: LeadershipEnv): Leadership {
  const id = env.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  let leading = false
  let letGo: (() => void) | null = null
  /** The request waiting in line for the lock, while this tab is in view. */
  let waiting: AbortController | null = null
  const leadListeners = new Set<(leading: boolean) => void>()
  const messageListeners = new Set<(msg: SyncMessage) => void>()

  env.channel.addEventListener('message', e => {
    const msg = e.data as SyncMessage | null
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || msg.from === id) return
    for (const l of [...messageListeners]) l(msg)
  })

  /** Hold the lock until release(). */
  const hold = (): Promise<void> => {
    leading = true
    waiting = null
    for (const l of [...leadListeners]) l(true)
    return new Promise<void>(resolve => {
      letGo = () => {
        letGo = null
        leading = false
        for (const l of [...leadListeners]) l(false)
        resolve()
      }
    })
  }

  /** Wait in line for the lock; asks a leader out of view to give it up. */
  const queue = () => {
    if (leading || waiting) return
    const ctrl = new AbortController()
    waiting = ctrl
    env.locks
      .request(LOCK_NAME, { signal: ctrl.signal }, () => (ctrl.signal.aborted ? undefined : hold()))
      .catch(() => {
        /* AbortError: this tab went out of view while it waited */
      })
      .finally(() => {
        if (waiting === ctrl) waiting = null
      })
    post({ type: 'want', from: id })
  }

  const post = (msg: SyncMessage) => {
    try {
      env.channel.postMessage(msg)
    } catch {
      /* a closed channel: nobody left to tell */
    }
  }

  // The lock at once if nobody holds it; otherwise, in view, wait in line.
  const ready = env.locks
    .request(LOCK_NAME, { ifAvailable: true }, lock => (lock ? hold() : undefined))
    .catch(() => {})
    .then(() => undefined)
  // ifAvailable answers before the callback's promise settles only when the
  // lock was not free, so `ready` would wait for the whole lead otherwise
  const decided = new Promise<void>(resolve => {
    // a lock granted before this line (a callback run at once) has already said so
    if (leading) return resolve()
    const check = (on: boolean) => {
      if (!on) return
      leadListeners.delete(check)
      resolve()
    }
    leadListeners.add(check)
    void ready.then(() => {
      leadListeners.delete(check)
      resolve()
    })
  }).then(() => {
    if (!leading && env.visible()) queue()
  })

  return {
    id,
    ready: decided,
    leading: () => leading,
    setVisible(visible) {
      if (visible) queue()
      else if (waiting) {
        waiting.abort()
        waiting = null
      }
    },
    async othersWaiting() {
      if (!env.locks.query) return false
      try {
        const q = await env.locks.query()
        return (q.pending ?? []).some(p => p.name === LOCK_NAME)
      } catch {
        return false
      }
    },
    release() {
      letGo?.()
    },
    onLeadChange(cb) {
      leadListeners.add(cb)
      return () => void leadListeners.delete(cb)
    },
    post,
    onMessage(cb) {
      messageListeners.add(cb)
      return () => void messageListeners.delete(cb)
    },
  }
}
