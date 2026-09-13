import { useEffect, useRef } from 'react'
import type { TaskStatus } from '../../types'
import type { Store } from '../../store'
import { newerStamp } from '../../itemops'
import { closeExternal, isAppLockShowing, onAppLockCleared } from '../../native'
import { paramsOf, parseLink } from '../../links'
import { appendEntry, entryOn, localDayKey } from '../../journal'
import { LEGACY_VIEW_TO_HOME, LEGACY_VIEW_TO_TASKS, VIEWS, type PendingLink, type View } from './routes'
import type { useNavigation } from './useNavigation'
import type { useOverlays } from './useOverlays'
import type { useToast } from './useToast'

type Nav = ReturnType<typeof useNavigation>
type Overlays = ReturnType<typeof useOverlays>

interface Deps {
  store: Store
  showToast: ReturnType<typeof useToast>['showToast']
  setSettingsNonce: Overlays['setSettingsNonce']
  setSettingsOpen: Overlays['setSettingsOpen']
  setAdminOpen: Overlays['setAdminOpen']
  setEditor: Overlays['setEditor']
  newTask: Overlays['newTask']
  openSheet: Overlays['openSheet']
  goTasksTab: Nav['goTasksTab']
  goPeopleTab: Nav['goPeopleTab']
  setHomeTab: Nav['setHomeTab']
  setView: Nav['setView']
  openJournal: Nav['openJournal']
  openPlace: Nav['openPlace']
  changeStatus: (id: string, status: TaskStatus) => void
  defer: (id: string, day: Date) => void
}

/**
 * Every inbound link — the web query string, the share target, a drafter://
 * URL, a notification tap, a calendar consent return — read in one place, held
 * back until the data has loaded and the lock card is down, then replayed.
 */
export function useDeepLinks({
  store,
  showToast,
  setSettingsNonce,
  setSettingsOpen,
  setAdminOpen,
  setEditor,
  newTask,
  openSheet,
  goTasksTab,
  goPeopleTab,
  setHomeTab,
  setView,
  openJournal,
  openPlace,
  changeStatus,
  defer,
}: Deps) {
  // Every way in, understood in one place: the PWA share target, ?new=, ?task=,
  // ?view=, a push tap, the drafter:// scheme, and the return from a calendar
  // consent screen. Anything that needs data waits for the store to load.
  const pendingLink = useRef<PendingLink | null>(null)
  // `fromNotification` is the only way an `act=` button is honoured: a reminder's
  // Done writes on arrival, so the web query string and the share target must not
  // be able to ask for it.
  const applyLink = (raw: string | URLSearchParams | PendingLink, hostHint = '', fromNotification = false) => {
    const src: PendingLink =
      raw instanceof URLSearchParams
        ? { host: hostHint, params: raw, allowAct: fromNotification }
        : typeof raw === 'object' && raw && 'params' in raw
          ? { allowAct: fromNotification, ...raw }
          : { ...paramsOf(typeof raw === 'string' ? raw : String(raw)), allowAct: fromNotification }
    const { host, params } = src
    const allowAct = !!src.allowAct
    const parsed = parseLink(params, { host, allowAct })
    if (parsed.oauth) {
      void closeExternal()
      const who = parsed.oauth.provider === 'microsoft' ? 'Outlook' : 'Google Calendar'
      showToast(
        parsed.oauth.ok
          ? `${who} connected — pick the calendars to show in Settings.`
          : `${who} could not be connected (${parsed.oauth.reason ?? 'unknown error'}).`,
      )
      setSettingsNonce(n => n + 1)
      setSettingsOpen(true)
      return
    }
    // Nothing below this line may run behind the lock card: a Done button that
    // fires while the overlay is up would write, toast, and time out unseen.
    if (!store.loaded || isAppLockShowing()) {
      pendingLink.current = { host, params, allowAct }
      return
    }
    if (parsed.view === 'admin') {
      setAdminOpen(true)
      return
    }
    // Every inbound link lands on the view it names. Views that became segments
    // still resolve: board / bills / notes open the Tasks tab on that segment,
    // and the former today / review views open Home on the day or the week.
    if (parsed.view && LEGACY_VIEW_TO_TASKS[parsed.view]) {
      goTasksTab(LEGACY_VIEW_TO_TASKS[parsed.view])
      setView('tasks')
    } else if (parsed.view && LEGACY_VIEW_TO_HOME[parsed.view]) {
      setHomeTab(LEGACY_VIEW_TO_HOME[parsed.view])
      setView('home')
    } else if (parsed.view && (VIEWS as string[]).includes(parsed.view)) {
      setView(parsed.view as View)
    }
    if (parsed.tab === 'journal') {
      // land on today's editor, not just the tab — this is the quick action's route
      openJournal(localDayKey())
    } else if (parsed.tab) {
      goPeopleTab(parsed.tab)
      setView('people')
    }
    if (parsed.plan) {
      // A planning sheet and nothing else — the morning digest, a Shortcut's
      // drafter://open?plan=day. The link writes nothing, and whatever else it
      // carries is ignored; the sheet writes only when its own button is
      // pressed. With no view of its own it opens over where the plan shows
      // once it is applied: the day, or for next week the Week segment.
      if (!parsed.view) {
        setHomeTab(parsed.plan === 'week' ? 'week' : 'today')
        setView('home')
      }
      openSheet(parsed.plan === 'day' ? { kind: 'day' } : parsed.plan === 'week' ? { kind: 'week' } : { kind: 'shutdown' })
      return
    }
    if (parsed.journal) {
      // a line from a Shortcut / share lands in today's entry; nothing already written is touched
      const line = parsed.journal
      const write = () => {
        const today = localDayKey()
        const existing = entryOn(journalRef.current, today)
        const next = appendEntry(existing, today, line)
        store.upsert(next)
        showToast(
          'Added to today’s journal',
          existing ? () => store.upsert({ ...existing, updatedAt: newerStamp(next.updatedAt) }) : () => store.remove(next.id),
        )
      }
      // Nothing writes on arrival here. drafter://journal is the owner's own
      // Shortcut, but a page open in Safari can set location.href to the same
      // string and iOS's “Open in Drafter?” prompt says nothing about what is
      // being written — so the line is shown first and lands only on the button.
      // The Shortcut costs one tap; a web page cannot spend it.
      showToast(`Add to today’s journal: “${line.length > 80 ? line.slice(0, 79) + '…' : line}”`, undefined, { label: 'Add', run: write })
      openJournal()
      return
    }
    if (parsed.saw) {
      const person = store.people.find(p => p.id === parsed.saw)
      if (person) {
        const log = () => {
          const now = new Date().toISOString()
          const id = crypto.randomUUID()
          store.upsert({
            kind: 'task',
            id,
            title: `Saw ${person.name}`,
            description: '',
            status: 'done',
            priority: 'normal',
            completedAt: now,
            createdAt: now,
            updatedAt: now,
            tags: ['visit'],
            peopleIds: [person.id],
          })
          showToast(`Logged a visit with ${person.name}`, () => store.remove(id))
        }
        // Only the reminder's own “Saw them” button writes, the same way Done and
        // Tomorrow do below. Reading whose birthday it is — tapping the banner, or
        // any other producer of a ?saw= link — opens People and offers the write.
        if (parsed.act === 'saw') log()
        else showToast(`Log a visit with ${person.name}?`, undefined, { label: 'Saw them', run: log })
        goPeopleTab('people')
        setView('people')
      } else showToast('That person is not on this device yet.')
      return
    }
    if (parsed.task) {
      const t = store.tasks.find(x => x.id === parsed.task)
      if (!t) {
        showToast('That task is not on this device yet — it will appear after the next sync.')
        return
      }
      // Done / Tomorrow came from the reminder's own buttons: do the thing the
      // swipe would have done, and leave its undo toast on screen. A banner can
      // outlive the task it names (finished on another device), and both writes
      // go quiet in that case — so say so rather than open to nothing.
      if (parsed.act === 'done') {
        if (t.status === 'done') showToast('Already done.')
        else changeStatus(t.id, 'done')
      } else if (parsed.act === 'tomorrow') {
        if (t.status === 'done') showToast('Already done — nothing to move.')
        else {
          const tomorrow = new Date()
          tomorrow.setDate(tomorrow.getDate() + 1)
          defer(t.id, tomorrow)
        }
      } else setEditor({ task: t })
      return
    }
    if (parsed.place) {
      // "Been a while" reminders link here. Nothing is written on arrival: the
      // row opens on Places with its history and its Log an outing button.
      const place = store.places.find(p => p.id === parsed.place)
      if (place) openPlace(place.id)
      else showToast('That place is not on this device yet — it will appear after the next sync.')
      return
    }
    if (parsed.capture) {
      // through newTask, so the quick action and the + button file a new task
      // the same way
      newTask(
        {
          title: parsed.capture.title,
          description: parsed.capture.description ?? '',
          link: parsed.capture.link,
          status: 'todo',
          ...(parsed.capture.dueAt ? { dueAt: parsed.capture.dueAt } : {}),
        },
        { capture: !!(parsed.capture.title.trim() || parsed.capture.link || parsed.capture.description) },
      )
    }
  }
  const applyLinkRef = useRef(applyLink)
  applyLinkRef.current = applyLink
  // the deferred "Add" on a web ?journal= link must append to the entry as it is when pressed
  const journalRef = useRef(store.journal)
  journalRef.current = store.journal

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if ([...params.keys()].length) {
      applyLinkRef.current(params)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])
  useEffect(() => {
    if (!store.loaded || !pendingLink.current) return
    const p = pendingLink.current
    pendingLink.current = null
    applyLinkRef.current(p)
  }, [store.loaded])
  // a link that arrived while the app was locked is replayed the moment it opens
  useEffect(
    () =>
      onAppLockCleared(() => {
        const p = pendingLink.current
        if (!p) return
        pendingLink.current = null
        applyLinkRef.current(p)
      }),
    [],
  )

  return { applyLinkRef }
}
