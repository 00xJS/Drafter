import { useMemo, useRef, useState } from 'react'
import type { CalendarEntry } from '../../types'
import type { useHousehold } from '../../household'
import type { Store } from '../../store'
import {
  entryToEvent,
  pushEventToGoogle,
  pushEventToMicrosoft,
  GOOGLE_PUSH_ID,
  googlePushId,
  useCalendarEvents,
  useGooglePush,
  useMicrosoftSync,
  entryPullWrites,
  mirrorChangeWrites,
  type EntryChange,
  type GoogleChange,
  type MirrorDone,
} from '../../calendars'
import { requestWeatherRefresh } from '../../weather'
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

  /** A mirrored task moved (or was deleted) in an external calendar: mirrorChangeWrites decides, this saves and says so. */
  const applyMirrorChanges = (changes: GoogleChange[], source: string) => {
    const { writes, done } = mirrorChangeWrites(store.tasks, changes)
    for (const t of writes) store.upsert(t)
    const undone: MirrorDone[] = []
    for (const d of done) if (store.setStatus(d.id, 'done')) undone.push(d)
    if (writes.length) showToast(`${writes.length} task${writes.length === 1 ? '' : 's'} moved from ${source}`)
    if (undone.length)
      showToast(`${undone.length} task${undone.length === 1 ? '' : 's'} marked done from ${source}`, () => {
        for (const u of undone) store.setStatus(u.id, u.prevStatus)
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
  /**
   * Take an entry off the calendar and off every mirror, quietly: the caller
   * says what happened — deleteEvent's toast, or the Undo of a plan that added
   * time blocks. Returns the entry as it was, for an Undo that puts it back.
   */
  const removeEvent = (id: string): CalendarEntry | undefined => {
    const gone = store.events.find(e => e.id === id)
    store.remove(id)
    if (gone) mirrorEvent({ ...gone, deletedAt: new Date().toISOString() })
    return gone
  }
  const deleteEvent = (id: string) => {
    const gone = removeEvent(id)
    showToast('Event deleted', () => {
      store.restore([id])
      // Undo has to put it back on the mirrors too, or it lives only in Drafter
      if (gone) mirrorEvent(gone, { revive: true })
    })
  }

  /**
   * One refresh for both the header pill and the pull-down: the set that runs
   * when the app comes back to the foreground — the items sync, the calendar
   * feeds, what moved in Google or Outlook, and the briefing's weather.
   * allSettled so one failing feed cannot stop the items sync; each piece
   * reports its own error in its own place. The weather is only asked (the
   * strip refreshes itself when it is on screen, and for this ask fetches
   * now rather than trusting its half-hour cache), so the spinner never
   * waits on it.
   * The GitHub board pull refreshes itself on foreground and is left to its
   * own timer here.
   */
  const manualSync = async () => {
    setSyncing(true)
    requestWeatherRefresh()
    try {
      await Promise.allSettled([store.syncNowManual(), calendars.refresh(), googlePush.pullNow(), microsoftSync.pullNow()])
    } finally {
      setSyncing(false)
    }
  }

  /** Our own entries go out to at least one calendar — Google, or any Outlook account — so a time block shows there as busy. */
  const mirrorsOn = mirroring || msMirrorIds.length > 0

  return { calendars, allEvents, sourceMap, googlePush, microsoftSync, mirrorEvent, mirrorsOn, saveEvents, removeEvent, deleteEvent, syncing, manualSync }
}
