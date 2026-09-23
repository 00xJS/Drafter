import type { SyncEngine, SyncTimers } from './syncengine'

// Live updates. Supabase Realtime tells this device when a row of public.posts
// it may read was written, and the engine runs its ordinary delta round a
// moment later. The message is a nudge and nothing more: its row is never
// applied as a record, so there is still one way a change reaches the cache —
// applySync, with its merge, its cursor and its revocations.
//
// Who hears what is the table's SELECT policy, which Realtime checks for every
// subscriber before it delivers an INSERT or an UPDATE: "household access" on
// posts (20261004000000), your own rows plus a household member's unless the
// kind is personal (PERSONAL_KINDS) or the record withholds itself. A peer's
// journal, wardrobe or chat is never delivered here — not even as a nudge.
//
// DELETE is not listened to. Realtime cannot apply a policy to a row that is
// gone, so a delete goes to every subscriber with its id; and a round has
// nothing to fetch for one anyway. "Delete forever" writes a tombstone, which
// is an UPDATE; a row is deleted outright only when its tombstone ages out or
// its account is removed, and neither needs a round.
//
// While the channel is live the engine's periodic round slows to a safety net
// (LIVE_PERIODIC_MS): it is what still revokes a record a peer withholds, since
// a row this reader may no longer select sends them no change at all.

/** A burst of changes is one round: this long after the last of them… */
export const NUDGE_MS = 750
/** …but never longer than this after the first, however steadily they come. */
export const NUDGE_MAX_MS = 5_000
/** A channel the server closed is opened again after this long, doubling while it keeps closing. */
export const REOPEN_MS = 30_000
export const REOPEN_CAP_MS = 10 * 60_000

/**
 * A row of public.posts as a change carries it: the table's columns, not the
 * record's fields. Only `id`, `user_id` and the stamp inside `data` are read,
 * and only to tell this device's own push coming back from news.
 */
export interface PostsRow {
  id?: unknown
  user_id?: unknown
  updated_at?: unknown
  synced_at?: unknown
  data?: unknown
}

export interface PostsChange {
  new?: PostsRow
}

/** What the server says about the channel's own subscription to the table. */
export interface SystemNews {
  extension?: string
  status?: string
  message?: string
}

/** The part of a Supabase Realtime channel this needs (a SupabaseClient's, or a fake). */
export interface LiveChannel {
  on(type: 'postgres_changes', filter: { event: 'INSERT' | 'UPDATE'; schema: 'public'; table: 'posts' }, callback: (change: PostsChange) => void): LiveChannel
  on(type: 'system', filter: Record<string, never>, callback: (news: SystemNews) => void): LiveChannel
  subscribe(callback: (status: string, err?: Error) => void): LiveChannel
}

export interface LiveClient {
  channel(name: string): LiveChannel
  removeChannel(channel: LiveChannel): Promise<unknown>
}

export interface RealtimeDeps {
  client: LiveClient
  engine: Pick<SyncEngine, 'nudge' | 'setLive' | 'holds'>
  timers?: Pick<SyncTimers, 'setTimeout' | 'clearTimeout'>
  now?: () => number
}

export interface LiveWatch {
  /** Open the channel again if it is down (or paused): the app came back, or a session did. */
  resume(): void
  /** Close the channel until resume, at the everyday poll: signed out. */
  pause(): void
  /** Close it for good: the account changed, or the planner went away. */
  stop(): void
  /** Where the channel stands — for tests and diagnostics. */
  state(): 'live' | 'joining' | 'joined' | 'down' | 'paused' | 'stopped'
}

const defaultTimers: Pick<SyncTimers, 'setTimeout' | 'clearTimeout'> = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: h => globalThis.clearTimeout(h as number),
}

/**
 * Every channel gets a topic of its own. supabase-js hands back the existing
 * channel for a topic it still holds, and one still closing would refuse the
 * listeners a new one needs.
 */
let topics = 0

/** Open the live channel for the signed-in account and keep it open. */
export function watchRealtime(deps: RealtimeDeps): LiveWatch {
  const { client, engine } = deps
  const timers = deps.timers ?? defaultTimers
  const now = deps.now ?? (() => Date.now())

  let channel: LiveChannel | null = null
  /** Moves on whenever a channel is let go: whatever an older one says after that is not news. */
  let gen = 0
  /** The channel is SUBSCRIBED… */
  let joined = false
  /** …and the server says its subscription to the table is on. */
  let listening = false
  /** Both, as the engine was last told. */
  let live = false
  /** The last word on the channel was an error, a timeout or a close. */
  let down = false
  let paused = false
  let stopped = false
  let nudgeTimer: unknown = undefined
  let waitingSince: number | null = null
  let reopenTimer: unknown = undefined
  let reopenWait = REOPEN_MS

  function update(): void {
    const next = joined && listening && !paused && !stopped
    if (next === live) return
    live = next
    engine.setLive(next)
    // what changed while the channel was coming up was never sent: one round catches up
    if (next) schedule()
  }

  function schedule(): void {
    const t = now()
    waitingSince ??= t
    if (nudgeTimer !== undefined) timers.clearTimeout(nudgeTimer)
    nudgeTimer = timers.setTimeout(fire, Math.max(0, Math.min(NUDGE_MS, waitingSince + NUDGE_MAX_MS - t)))
  }

  function fire(): void {
    nudgeTimer = undefined
    waitingSince = null
    void engine.nudge()
  }

  function cancelNudge(): void {
    if (nudgeTimer !== undefined) timers.clearTimeout(nudgeTimer)
    nudgeTimer = undefined
    waitingSince = null
  }

  function cancelReopen(): void {
    if (reopenTimer !== undefined) timers.clearTimeout(reopenTimer)
    reopenTimer = undefined
  }

  function onChange(g: number, change: PostsChange | undefined): void {
    if (g !== gen || paused || stopped) return
    const row = change?.new
    const id = typeof row?.id === 'string' ? row.id : null
    const data = row?.data && typeof row.data === 'object' ? (row.data as { updatedAt?: unknown }) : null
    const stamp = typeof data?.updatedAt === 'string' ? data.updatedAt : null
    const owner = typeof row?.user_id === 'string' ? row.user_id : null
    // this device's own push coming back: it already holds exactly that
    if (id && stamp && engine.holds(id, stamp, owner)) return
    schedule()
  }

  function onSystem(g: number, news: SystemNews | undefined): void {
    if (g !== gen || news?.extension !== 'postgres_changes') return
    // 'error' is what a table missing from the publication gets: joined, and deaf
    listening = news.status === 'ok'
    update()
  }

  function onStatus(g: number, status: string): void {
    if (g !== gen) return
    if (status === 'SUBSCRIBED') {
      joined = true
      down = false
      reopenWait = REOPEN_MS
    } else {
      joined = false
      listening = false
      down = true
      // an error or a timeout, supabase-js rejoins by itself; a closed channel is gone
      if (status === 'CLOSED') reopenLater()
    }
    update()
  }

  function subscribe(): void {
    const g = ++gen
    joined = false
    listening = false
    down = false
    let ch: LiveChannel | null = null
    try {
      ch = client.channel(`drafter-posts-${++topics}`)
      channel = ch
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, change => onChange(g, change))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, change => onChange(g, change))
        .on('system', {}, news => onSystem(g, news))
        .subscribe(status => onStatus(g, status))
    } catch (e) {
      // no socket to be had (a browser without WebSocket): the everyday poll goes on
      console.error('Live updates are unavailable', e)
      down = true
      if (ch) release(ch)
      if (channel === ch) channel = null
    }
    update()
  }

  function release(ch: LiveChannel): void {
    try {
      void client.removeChannel(ch).catch(() => {})
    } catch {
      /* already gone */
    }
  }

  /** Let the channel go; nothing it says from now on counts. */
  function drop(): void {
    gen++
    joined = false
    listening = false
    const ch = channel
    channel = null
    update()
    if (ch) release(ch)
  }

  function reopenLater(): void {
    if (stopped || paused || reopenTimer !== undefined) return
    reopenTimer = timers.setTimeout(() => {
      reopenTimer = undefined
      if (stopped || paused || !down) return
      reopenWait = Math.min(REOPEN_CAP_MS, reopenWait * 2)
      drop()
      subscribe()
    }, reopenWait)
  }

  subscribe()

  return {
    resume() {
      if (stopped) return
      const wasPaused = paused
      paused = false
      // joining, or up: leave it be — a zombie socket is supabase-js's heartbeat's to find
      if (channel && !down && !wasPaused) return
      cancelReopen()
      drop()
      subscribe()
    },
    pause() {
      if (stopped || paused) return
      paused = true
      cancelReopen()
      cancelNudge()
      drop()
    },
    stop() {
      if (stopped) return
      stopped = true
      cancelReopen()
      cancelNudge()
      drop()
    },
    state() {
      if (stopped) return 'stopped'
      if (paused) return 'paused'
      if (live) return 'live'
      if (down) return 'down'
      return joined ? 'joined' : 'joining'
    },
  }
}
