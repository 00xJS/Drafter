import { apiFetch } from './api'
import { COOK_TASK_PREFIX } from './kitchen'
import type { Item, Task } from './types'
import type { ActivityEvent } from '../shared/notices.mts'

// Telling the other member what you changed on a task you share.
//
// Every edit made on this device goes through the store (src/store.ts), which
// hands the task before and after to noteTaskEdit. What changed — a status, a
// step ticked, a comment, the due date, the title, who is doing it — is kept
// here per task, in localStorage so an edit made offline still gets told, and
// sent to /api/notify once the task has been quiet for DEBOUNCE_MS and the
// server has the edit. The server decides who hears of it (the other member,
// if they are party to the task and want to know), writes their notice for
// the hub and pushes it. A change that arrives from the server never passes
// through here: only the person who made a change reports it.
//
// Changes coalesce while they wait. A status moved and moved back is no news
// (Done, then Undo); a step ticked and unticked neither; a comment deleted
// before it was sent is not sent. What is still unsent after a day is dropped.

/** A change waiting to be told, with what the queue needs to fold later ones into it. */
export interface QueuedEvent extends ActivityEvent {
  /** One per status, due date, title and assignee; one per step and comment. */
  key: string
  /** What it was before the first change of this run, for the fields that can change back. */
  from?: string
}

/** How long a task stays quiet before what changed on it is sent. */
export const DEBOUNCE_MS = 10_000
/** A task whose edit the server has not confirmed yet is looked at again this often. */
export const PENDING_RECHECK_MS = 5_000
/** Unsent after this long, it is no longer news. */
export const MAX_AGE_MS = 24 * 3_600_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 30 * 60_000

/** The members a task concerns besides `myId`: whoever does it, handed it over, or owns it. */
function othersOn(t: Task | undefined, myId: string): boolean {
  return !!t && [t.assigneeId, t.assignedBy, t.ownerId].some(id => !!id && id !== myId)
}

/**
 * What a local edit changed on a task, for the other member: status, a step
 * ticked or unticked, a comment added, the due date, the title, the assignee.
 * Nothing when nobody else is party to the task — no other assignee,
 * assigner or owner — or when it is mine and kept private, which nobody else
 * can read; nothing in local mode (`myId` null), where there is nobody else.
 */
export function taskActivity(before: Task | undefined, after: Task, myId: string | null): QueuedEvent[] {
  if (!myId || after.kind !== 'task' || after.deletedAt || after.purged) return []
  if (!othersOn(after, myId) && !othersOn(before, myId)) return []
  if (after.shared === false && (!after.ownerId || after.ownerId === myId)) return []
  const out: QueuedEvent[] = []
  if (!before) {
    if (after.assigneeId && after.assigneeId !== myId) out.push({ type: 'assigned', key: 'assigned', detail: after.assigneeId, from: '' })
    return out
  }
  if (before.status !== after.status) out.push({ type: 'status', key: 'status', detail: after.status, from: before.status })
  const was = new Map((before.checklist ?? []).map(c => [c.id, c]))
  for (const c of after.checklist ?? []) {
    const old = was.get(c.id)
    if (old && old.done !== c.done) out.push({ type: 'checklist', key: `step:${c.id}`, detail: c.text, done: c.done })
  }
  const said = new Set((before.comments ?? []).map(c => c.id))
  for (const c of after.comments ?? []) if (!said.has(c.id)) out.push({ type: 'comment', key: `comment:${c.id}`, detail: c.body })
  const due = (iso?: string) => {
    const ms = Date.parse(iso ?? '')
    return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
  }
  if (due(before.dueAt) !== due(after.dueAt)) out.push({ type: 'due', key: 'due', detail: due(after.dueAt), from: due(before.dueAt) })
  // a cook task's title follows its meal, and either member's device writes it (useCookTaskSync)
  if (before.title.trim() !== after.title.trim() && !after.id.startsWith(COOK_TASK_PREFIX)) {
    out.push({ type: 'title', key: 'title', detail: after.title.trim(), from: before.title.trim() })
  }
  // every change of hands, so handing it over and back again cancels out
  // while it waits; one that leaves nobody else doing it is not sent (worthTelling)
  if ((before.assigneeId ?? '') !== (after.assigneeId ?? '')) out.push({ type: 'assigned', key: 'assigned', detail: after.assigneeId ?? '', from: before.assigneeId ?? '' })
  return out
}

/** What is worth sending: a hand-over to nobody, or to me, only ever served to cancel one out. */
export function worthTelling(events: readonly QueuedEvent[], myId: string): QueuedEvent[] {
  return events.filter(e => e.type !== 'assigned' || (!!e.detail && e.detail !== myId))
}

/**
 * Fold `incoming` into what is already waiting. A field changed again keeps
 * where it started and takes where it ended, and goes altogether when those
 * are the same; a step flipped back goes; a comment is kept once. Comments no
 * longer on the task (`comments`, when known) were deleted unsent, and go.
 */
export function coalesce(waiting: readonly QueuedEvent[], incoming: readonly QueuedEvent[], comments?: ReadonlySet<string>): QueuedEvent[] {
  let out = [...waiting]
  for (const e of incoming) {
    const i = out.findIndex(w => w.key === e.key)
    if (i < 0) {
      out.push(e)
      continue
    }
    const prev = out[i]
    if (e.type === 'comment') continue
    if (e.type === 'checklist') {
      // ticked then unticked, or the other way: as it was
      out = prev.done !== e.done ? out.filter((_, j) => j !== i) : out.map((w, j) => (j === i ? e : w))
      continue
    }
    const next = { ...e, from: prev.from }
    out = next.detail === next.from ? out.filter((_, j) => j !== i) : [...out.filter((_, j) => j !== i), next]
  }
  return comments ? out.filter(e => e.type !== 'comment' || comments.has(e.key.slice('comment:'.length))) : out
}

/** One task's changes waiting to be sent. */
interface Entry {
  events: QueuedEvent[]
  /** The first change still waiting, and the latest (epoch ms). */
  first: number
  last: number
  tries: number
  /** Not before (epoch ms): a refusal's backoff. */
  next: number
}

type Queue = Record<string, Entry>

export interface ActivityDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** POST /api/notify; resolves the answer's status, 0 when the request never got one. */
  send(body: { taskId: string; events: ActivityEvent[] }): Promise<number>
  /** The server has not confirmed this task's latest edit yet. */
  pending(taskId: string): boolean
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** The queue for one signed-in member. */
export function createActivityQueue(myId: string, deps: ActivityDeps) {
  const key = `drafter:activity:${myId}`
  let memory: Queue = {}
  // storage that refused a write (full, or blocked): this session's copy is the one to read from then
  let inMemory = !deps.storage
  let timer: unknown = null
  let flushing = false
  let stopped = false

  const read = (): Queue => {
    if (inMemory || !deps.storage) return memory
    try {
      const raw = JSON.parse(deps.storage.getItem(key) ?? '{}') as unknown
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Queue) : {}
    } catch {
      return {}
    }
  }
  const write = (q: Queue) => {
    memory = q
    if (inMemory || !deps.storage) return
    try {
      if (Object.keys(q).length === 0) deps.storage.removeItem(key)
      else deps.storage.setItem(key, JSON.stringify(q))
    } catch {
      // kept for this session only
      inMemory = true
    }
  }

  /** When the entry may go: quiet for DEBOUNCE_MS, and past any backoff. */
  const dueAt = (e: Entry) => Math.max(e.last + DEBOUNCE_MS, e.next)

  function schedule() {
    if (stopped) return
    deps.clearTimeout(timer)
    timer = null
    const q = read()
    // the next to go, or to be let go unsent: a change is not news for ever
    const times = Object.values(q).map(e => Math.min(dueAt(e), e.first + MAX_AGE_MS + 1))
    if (times.length === 0) return
    timer = deps.setTimeout(() => void flush(), Math.max(0, Math.min(...times) - deps.now()))
  }

  function note(before: Item | undefined, after: Item): void {
    if (after.kind !== 'task') return
    const incoming = taskActivity(before?.kind === 'task' ? before : undefined, after, myId)
    const q = read()
    const had = q[after.id]
    if (!incoming.length && !had) return
    const now = deps.now()
    const events = coalesce(had?.events ?? [], incoming, new Set((after.comments ?? []).map(c => c.id)))
    if (events.length) q[after.id] = { events, first: had?.first ?? now, last: incoming.length ? now : (had?.last ?? now), tries: had?.tries ?? 0, next: had?.next ?? 0 }
    else delete q[after.id]
    write(q)
    schedule()
  }

  /** Change one task's entry as it stands now (null takes it away): never a copy read before an await. */
  const update = (taskId: string, fn: (e: Entry) => Entry | null) => {
    const q = read()
    if (!q[taskId]) return
    const next = fn(q[taskId])
    if (next) q[taskId] = next
    else delete q[taskId]
    write(q)
  }
  const same = (a: QueuedEvent) => `${a.key}|${a.detail ?? ''}|${a.done ?? ''}|${a.from ?? ''}`

  async function flush(): Promise<void> {
    if (flushing || stopped) return
    flushing = true
    try {
      const now = deps.now()
      for (const taskId of Object.keys(read())) {
        const e = read()[taskId]
        if (!e) continue
        if (now - e.first > MAX_AGE_MS) {
          update(taskId, () => null)
          continue
        }
        if (dueAt(e) > now) continue
        // the server does not have the edit yet: what it would read is the task before it
        if (deps.pending(taskId)) {
          update(taskId, cur => ({ ...cur, next: now + PENDING_RECHECK_MS }))
          continue
        }
        const events = worthTelling(e.events, myId).map(({ type, detail, done }) => ({ type, ...(detail !== undefined ? { detail } : {}), ...(done !== undefined ? { done } : {}) }))
        const status = events.length ? await deps.send({ taskId, events }) : 204
        if (stopped) return
        if (status === 501) {
          // this site keeps no notices: nothing waiting ever will go
          write({})
          return
        }
        if ((status >= 200 && status < 300) || status === 400 || status === 404 || status === 413) {
          // told, or never will be; a change noted while it went stays for the next time
          const told = new Set(e.events.map(same))
          update(taskId, cur => {
            const rest = cur.events.filter(x => !told.has(same(x)))
            return rest.length ? { ...cur, events: rest, tries: 0, next: 0 } : null
          })
        } else {
          // offline, signed out for now, too many at once, the server down: later
          update(taskId, cur => ({ ...cur, tries: cur.tries + 1, next: now + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** cur.tries) }))
        }
      }
    } finally {
      flushing = false
      schedule()
    }
  }

  return {
    myId,
    note,
    flush,
    /** What is waiting, for tests. */
    waiting: (): Readonly<Queue> => read(),
    stop() {
      stopped = true
      deps.clearTimeout(timer)
      timer = null
    },
  }
}

type ActivityQueue = ReturnType<typeof createActivityQueue>

let active: ActivityQueue | null = null

function localStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Start telling for `myId` (the store's effect, once signed in with a
 * backend): what is waiting from before is sent, and again whenever the
 * connection or the app comes back. Returns the stop.
 */
export function watchActivity({ myId, pending }: { myId: string; pending(taskId: string): boolean }): () => void {
  active?.stop()
  const q = createActivityQueue(myId, {
    storage: localStore(),
    send: body =>
      apiFetch('/api/notify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(
        r => r.status,
        () => 0,
      ),
    pending,
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: h => globalThis.clearTimeout(h as number),
  })
  active = q
  const back = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void q.flush()
  }
  window.addEventListener('online', back)
  document.addEventListener('visibilitychange', back)
  void q.flush()
  return () => {
    window.removeEventListener('online', back)
    document.removeEventListener('visibilitychange', back)
    q.stop()
    if (active === q) active = null
  }
}

/** A local edit of a task, as the store makes it: noted for the member signed in, if telling has started. */
export function noteTaskEdit(before: Item | undefined, after: Item, myId: string | null): void {
  if (!myId || after.kind !== 'task' || active?.myId !== myId) return
  active.note(before, after)
}
