import { useMemo, useRef, useState } from 'react'
import type { CalendarEntry, TaskStatus } from '../../types'
import type { useHousehold } from '../../household'
import type { Store } from '../../store'
import { newerStamp, localMidnightIso } from '../../itemops'
import { entryToEvent, isMirroredTask, pushEventToGoogle, pushEventToMicrosoft, GOOGLE_PUSH_ID, googlePushId, useCalendarEvents, useGooglePush, useMicrosoftSync, entryPullWrites, type EntryChange } from '../../calendars'
import type { useToast } from './useToast'

interface Deps {
  store: Store
  household: ReturnType<typeof useHousehold>
  showToast: ReturnType<typeof useToast>['showToast']
}

/**
 * The calendars: the subscribed feeds, the Google and Outlook mirrors and what
 * comes back from them, our own entries written through to every mirror, and
 * the one refresh the header pill and the pull-down share.
 */
export function useCalendarSync({ store, household, showToast }: Deps) {
  const [syncing, setSyncing] = useState(false)
  const calendars = useCalendarEvents(store.calendars)
  /**
   * Feed occurrences and our own entries in one list, so the grids draw both
   * with the same code. Ours carry `localId`, which is what lets the day sheet
   * offer Edit on them and not on a read-only feed row.
   */
  const allEvents = useMemo(() => [...calendars.events, ...store.events.map(entryToEvent)], [calendars.events, store.events])
  const sourceMap = useMemo(() => new Map(store.calendars.map(c => [c.id, c])), [store.calendars])
  const myPushId = household.myId ? googlePushId(household.myId) : GOOGLE_PUSH_ID
  const mirroring = store.calendars.some(c => (c.id === myPushId || c.id === GOOGLE_PUSH_ID) && c.enabled)
  const msMirrorIds = useMemo(
    () => store.calendars.filter(c => c.enabled && c.url.startsWith('ms-push:')).map(c => c.url.slice('ms-push:'.length)),
    [store.calendars],
  )
  const googlePush = useGooglePush(
    store.allItems,
    store.projects,
    store.loaded && mirroring,
    changes => applyMirrorChanges(changes, 'Google Calendar'),
    household.myId,
    entries => applyEntryChanges(entries, 'Google Calendar'),
  )

  /** A mirrored task moved (or was deleted) in an external calendar. */
  const applyMirrorChanges = (
    changes: { taskId: string; deleted: boolean; start: string | null; updated: string; allDay?: boolean }[],
    source: string,
  ) => {
    let moved = 0
    const undone: { id: string; status: TaskStatus }[] = []
    for (const c of changes) {
      const t = store.tasks.find(x => x.id === c.taskId)
      if (!t || c.updated <= t.updatedAt) continue
      if (c.deleted) {
        // A cancelled event for a task that is no longer mirrored is our OWN
        // delete echoing back, not the owner deleting it in the provider: the
        // mirror removes the event the moment a task leaves the open, dated set
        // (wishlist, due date cleared, done, canceled), and the pull then sees
        // that cancellation. Reading it as "deleted in Google, so done" marked a
        // task done seconds after it was moved to Wishlist. Same rule the server
        // uses to decide what to mirror (lib/google.mjs pushTask `wanted`).
        if (!isMirroredTask(t)) continue
        const change = store.setStatus(t.id, 'done')
        if (change) undone.push({ id: t.id, status: change.prev.status })
        continue
      }
      if (!c.start) continue
      const next = c.allDay
        ? localMidnightIso(/^\d{4}-\d{2}-\d{2}/.exec(c.start)?.[0] ?? c.start.slice(0, 10))
        : new Date(c.start).toISOString()
      if (!next || next === t.dueAt) continue
      // compare all-day by local date key so a 09:00 rewrite is ignored
      if (c.allDay && t.dueAt) {
        const localKey = (iso: string) => {
          const d = new Date(iso)
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
        if (localKey(t.dueAt) === next.slice(0, 10) || localKey(t.dueAt) === c.start.slice(0, 10)) continue
      }
      store.upsert({ ...t, dueAt: next, updatedAt: newerStamp(t.updatedAt) })
      moved++
    }
    if (moved) showToast(`${moved} task${moved === 1 ? '' : 's'} moved from ${source}`)
    if (undone.length)
      showToast(`${undone.length} task${undone.length === 1 ? '' : 's'} marked done from ${source}`, () => {
        for (const u of undone) store.setStatus(u.id, u.status)
      })
  }

  // An event moved or retitled in Google or Outlook comes back the way a moved
  // task does — only when the provider's edit is newer than the entry's own.
  const applyEntryChanges = (changes: EntryChange[], source: string) => {
    const rows = entryPullWrites(store.events, changes)
    for (const r of rows) store.upsert(r)
    if (rows.length) showToast(`${rows.length} event${rows.length === 1 ? '' : 's'} updated from ${source}`)
  }

  const microsoftSync = useMicrosoftSync(
    store.allItems,
    store.projects,
    store.loaded ? msMirrorIds : [],
    changes => applyMirrorChanges(changes, 'Outlook'),
    household.myId,
    entries => applyEntryChanges(entries, 'Outlook'),
  )

  /**
   * Pushes for one entry to one provider run one after another. Without this a
   * quick Undo raced its own delete: the revive's lookup still saw the live copy
   * and patched it, then the DELETE landed, and the provider lost an entry that
   * Drafter still showed. Different entries and providers still run in parallel.
   */
  const mirrorChain = useRef(new Map<string, Promise<unknown>>())
  const enqueueMirror = (key: string, run: () => Promise<unknown>) => {
    const chain = mirrorChain.current
    const tail = (chain.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    chain.set(key, tail)
    void tail
      .finally(() => {
        if (chain.get(key) === tail) chain.delete(key)
      })
      .catch(() => {})
    return tail
  }

  /**
   * Write an entry through to every connected mirror: Google when its mirror is
   * on, and EACH enabled Microsoft account — the same fan-out task mirroring
   * uses. Best effort: the row is already saved locally, so a failed mirror
   * costs the copy in the provider, never the entry itself.
   */
  const mirrorEvent = (e: CalendarEntry, opts: { revive?: boolean } = {}) => {
    if (mirroring) void enqueueMirror(`google:${e.id}`, () => pushEventToGoogle(e, opts)).catch(() => {})
    for (const accountId of msMirrorIds) void enqueueMirror(`ms:${accountId}:${e.id}`, () => pushEventToMicrosoft(e, accountId)).catch(() => {})
  }
  /** The same fan-out, awaited, so a run of entries can be fed to the mirrors one at a time. */
  const mirrorEventNow = (e: CalendarEntry) =>
    Promise.allSettled([
      ...(mirroring ? [enqueueMirror(`google:${e.id}`, () => pushEventToGoogle(e))] : []),
      ...msMirrorIds.map(accountId => enqueueMirror(`ms:${accountId}:${e.id}`, () => pushEventToMicrosoft(e, accountId))),
    ]).then(() => undefined)
  /**
   * Save one entry, or a run of repeated work days. Every row lands locally at
   * once; a run is fed to the mirrors one entry at a time, so a dozen work days
   * do not fire two dozen provider calls in the same instant and trip limits.
   */
  const saveEvents = (entries: CalendarEntry[]) => {
    for (const e of entries) store.upsert(e)
    if (entries.length === 1) {
      mirrorEvent(entries[0])
      return
    }
    void (async () => {
      for (const e of entries) await mirrorEventNow(e)
    })()
    showToast(`${entries.length} work days added`)
  }
  const deleteEvent = (id: string) => {
    const gone = store.events.find(e => e.id === id)
    store.remove(id)
    if (gone) mirrorEvent({ ...gone, deletedAt: new Date().toISOString() })
    showToast('Event deleted', () => {
      store.restore([id])
      // Undo has to put it back on the mirrors too, or it lives only in Drafter
      if (gone) mirrorEvent(gone, { revive: true })
    })
  }

  /**
   * One refresh for both the header pill and the pull-down: the set that runs
   * when the app comes back to the foreground — the items sync, the calendar
   * feeds, and what moved in Google or Outlook. allSettled so one failing feed
   * cannot stop the items sync; each piece reports its own error in its own
   * place. The GitHub board pull and the weather card refresh themselves on
   * foreground and are left to their own timers here.
   */
  const manualSync = async () => {
    setSyncing(true)
    try {
      await Promise.allSettled([store.syncNowManual(), calendars.refresh(), googlePush.pullNow(), microsoftSync.pullNow()])
    } finally {
      setSyncing(false)
    }
  }

  return { calendars, allEvents, sourceMap, googlePush, microsoftSync, mirrorEvent, saveEvents, deleteEvent, syncing, manualSync }
}
