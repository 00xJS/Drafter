import { useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react'
import { CalendarEvent, Person, Place, Post, Project, STATUS_META, Task, TaskStatus, toPost } from '../types'
import { useItems } from '../store'
import { newerStamp, localMidnightIso } from '../itemops'
import { notifyDue } from '../notify'
import { getSupabase } from '../supabase'
import { clearLocalData } from '../idb'
import { projectById } from '../taskutils'
import { GOOGLE_PUSH_ID, googlePushId, eventStartDate, prepDueFor, useCalendarEvents, useGooglePush, useMicrosoftSync } from '../calendars'
import { parseGithubUrl, setIssueState } from '../github'
import { useHousehold } from '../household'
import { timeAgo } from '../utils'
import { closeExternal, initNative, isNative, localRemindersEnabled, scheduleLocalReminders, clearAppBadge } from '../native'
import { buildLocalReminders, deviceHasServerPush } from '../reminders'
import { fetchPushInfo } from '../push'
import { paramsOf, parseLink } from '../links'
import { Board } from './Board'
import { Calendar } from './Calendar'
import { Today } from './Today'
import { Roadmap } from './Roadmap'
import { TasksTable } from './TasksTable'
import { People } from './People'
import { Places } from './Places'
import { Review } from './Review'
import { Search } from './Search'
import { AttendancePicker } from './AttendancePicker'
import { TaskEditor } from './TaskEditor'
import { ProjectEditor } from './ProjectEditor'
import { NotesView } from './NotesView'
import { Trash } from './Trash'
import { Settings } from './Settings'
import { Admin } from './Admin'
import { ErrorBoundary } from './ErrorBoundary'
import { fetchAdminMe } from '../admin'

const Insights = lazy(() => import('./Insights').then(m => ({ default: m.Insights })))

type View = 'today' | 'tasks' | 'board' | 'calendar' | 'notes' | 'people' | 'review' | 'social'
const VIEWS: View[] = ['today', 'tasks', 'board', 'calendar', 'notes', 'people', 'review', 'social']
type CalendarMode = 'month' | 'timeline'
type PeopleTab = 'people' | 'places'

const VIEW_LABELS: Record<View, string> = {
  today: 'Today',
  tasks: 'Tasks',
  board: 'Board',
  calendar: 'Calendar',
  notes: 'Notes',
  people: 'People',
  review: 'Review',
  social: 'Social',
}

const FILTER_KEY = 'drafter:project-filter'
const CAL_MODE_KEY = 'drafter:calendar-mode'
const PEOPLE_TAB_KEY = 'drafter:people-tab'

interface Toast {
  msg: string
  undo?: () => void
}

export default function Planner() {
  const household = useHousehold()
  const store = useItems(household.myId)
  const [view, setView] = useState<View>('today')
  const [projectFilter, setProjectFilter] = useState<string>(() => {
    try {
      return localStorage.getItem(FILTER_KEY) ?? 'all'
    } catch {
      return 'all'
    }
  })
  const [calMode, setCalMode] = useState<CalendarMode>(() => {
    try {
      return localStorage.getItem(CAL_MODE_KEY) === 'timeline' ? 'timeline' : 'month'
    } catch {
      return 'month'
    }
  })
  const [peopleTab, setPeopleTab] = useState<PeopleTab>(() => {
    try {
      return localStorage.getItem(PEOPLE_TAB_KEY) === 'places' ? 'places' : 'people'
    } catch {
      return 'people'
    }
  })
  const [editor, setEditor] = useState<{ task?: Task; preset?: Partial<Task>; capture?: boolean } | null>(null)
  const [projectEditor, setProjectEditor] = useState<{ project?: Project } | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [mineOnly, setMineOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem('drafter:mine-only') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('drafter:mine-only', mineOnly ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [mineOnly])
  const inHousehold = !!household.info?.household && (household.info?.members.length ?? 0) > 1
  const [settingsOpen, setSettingsOpen] = useState(false)
  // bumped when a calendar consent flow returns, so an open Settings refetches
  const [settingsNonce, setSettingsNonce] = useState(0)
  const [adminOpen, setAdminOpen] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [syncing, setSyncing] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, projectFilter)
    } catch {
      /* ignore */
    }
  }, [projectFilter])
  useEffect(() => {
    try {
      localStorage.setItem(CAL_MODE_KEY, calMode)
    } catch {
      /* ignore */
    }
  }, [calMode])

  const projectMap = useMemo(() => projectById(store.projects), [store.projects])
  const calendars = useCalendarEvents(store.calendars)
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
  )

  // Cmd/Ctrl+K opens search from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Site-owner Admin entry: JWT email vs app_config.owner_email (server-side).
  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    let cancelled = false
    const check = () => {
      fetchAdminMe()
        .then(r => {
          if (!cancelled) setIsOwner(!!r.isOwner)
        })
        .catch(() => {
          if (!cancelled) setIsOwner(false)
        })
    }
    sb.auth.getSession().then(({ data }) => {
      if (data.session) check()
    })
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      if (session) check()
      else setIsOwner(false)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  // Every way in, understood in one place: the PWA share target, ?new=, ?task=,
  // ?view=, a push tap, the drafter:// scheme, and the return from a calendar
  // consent screen. Anything that needs data waits for the store to load.
  const pendingLink = useRef<{ host: string; params: URLSearchParams } | null>(null)
  const applyLink = (raw: string | URLSearchParams | { host: string; params: URLSearchParams }, hostHint = '') => {
    const { host, params } =
      raw instanceof URLSearchParams
        ? { host: hostHint, params: raw }
        : typeof raw === 'object' && raw && 'params' in raw
          ? raw
          : paramsOf(typeof raw === 'string' ? raw : String(raw))
    const parsed = parseLink(params, { host })
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
    if (!store.loaded) {
      pendingLink.current = { host, params }
      return
    }
    if (parsed.view === 'admin') {
      setAdminOpen(true)
      return
    }
    if (parsed.view && (VIEWS as string[]).includes(parsed.view)) setView(parsed.view as View)
    if (parsed.tab) {
      setPeopleTab(parsed.tab)
      try {
        localStorage.setItem(PEOPLE_TAB_KEY, parsed.tab)
      } catch {
        /* ignore */
      }
      setView('people')
    }
    if (parsed.saw) {
      const person = store.people.find(p => p.id === parsed.saw)
      if (person) {
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
        setView('people')
      } else showToast('That person is not on this device yet.')
      return
    }
    if (parsed.task) {
      const t = store.tasks.find(x => x.id === parsed.task)
      if (t) setEditor({ task: t })
      else showToast('That task is not on this device yet — it will appear after the next sync.')
      return
    }
    if (parsed.capture) {
      setEditor({
        preset: {
          title: parsed.capture.title,
          description: parsed.capture.description ?? '',
          link: parsed.capture.link,
          status: 'todo',
          ...(parsed.capture.dueAt ? { dueAt: parsed.capture.dueAt } : {}),
        },
        capture: !parsed.capture.dueAt && !!parsed.capture.title.trim(),
      })
    }
  }
  const applyLinkRef = useRef(applyLink)
  applyLinkRef.current = applyLink

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
  // the iOS shell: links, push taps, and a sync whenever the app comes forward
  useEffect(() => {
    let dispose = () => {}
    void initNative({
      onUrl: url => applyLinkRef.current(url),
      onResume: () => {
        void store.syncNowManual()
        remindersRef.current()
        void clearAppBadge()
      },
    }).then(d => {
      dispose = d
    })
    return () => dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        if (t.status === 'done' || t.status === 'canceled') continue
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

  const microsoftSync = useMicrosoftSync(
    store.allItems,
    store.projects,
    store.loaded ? msMirrorIds : [],
    changes => applyMirrorChanges(changes, 'Outlook'),
    household.myId,
  )

  const activeFilter = projectFilter !== 'all' && projectMap.has(projectFilter) ? projectFilter : 'all'
  const filteredTasks = useMemo(() => {
    let list = activeFilter === 'all' ? store.tasks : store.tasks.filter(t => t.projectId === activeFilter)
    if (mineOnly && inHousehold && household.myId) list = list.filter(t => (t.assigneeId ? t.assigneeId === household.myId : t.ownerId === household.myId || !t.ownerId))
    return list
  }, [store.tasks, activeFilter, mineOnly, inHousehold, household.myId])
  const posts = useMemo(() => filteredTasks.map(toPost).filter((p): p is Post => p !== null), [filteredTasks])
  // the social planner this app grew out of: only shown to someone who still has posts
  const hasSocial = useMemo(() => store.tasks.some(t => t.social), [store.tasks])
  const barProjects = useMemo(() => store.projects.filter(p => p.status !== 'archived'), [store.projects])

  const showToast = (msg: string, undo?: () => void) => {
    window.clearTimeout(toastTimer.current)
    setToast({ msg, undo })
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }

  // due reminders while the app is open (device-local, never a store write)
  const notifyRef = useRef(() => {})
  notifyRef.current = () => {
    notifyDue(store.tasks)
  }
  useEffect(() => {
    notifyRef.current()
    const t = window.setInterval(() => notifyRef.current(), 30_000)
    return () => window.clearInterval(t)
  }, [])

  // iOS: the phone itself fires a notification at each due time and on occasion
  // mornings — no server involved, so it works with no account and the app closed
  const remindersRef = useRef(() => {})
  remindersRef.current = () => {
    if (!isNative() || !localRemindersEnabled()) return
    void (async () => {
      let skipTaskDue = false
      try {
        const info = await fetchPushInfo()
        skipTaskDue = await deviceHasServerPush(info.subscriptions ?? [])
      } catch {
        /* offline / unsigned — keep local due reminders */
      }
      await scheduleLocalReminders(buildLocalReminders(store.tasks, store.people, new Date(), 30, { skipTaskDue }))
    })()
  }
  useEffect(() => {
    if (!store.loaded) return
    const t = window.setTimeout(() => remindersRef.current(), 1500)
    return () => window.clearTimeout(t)
  }, [store.loaded, store.tasks, store.people])

  const openTask = (task: Task) => setEditor({ task })
  const newTask = (preset?: Partial<Task>, opts?: { capture?: boolean }) =>
    setEditor({
      preset: { ...(activeFilter !== 'all' ? { projectId: activeFilter } : {}), ...preset },
      capture: opts?.capture ?? (!!preset?.title && !preset?.dueAt),
    })
  const openProject = (project: Project) => setProjectEditor({ project })
  /** One-tap "Saw them" with undo — used from Today, Search, and ?saw=. */
  const sawThem = (person: Person) => {
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
  /** A done task dated at the outing is what "seeing someone / going somewhere" is made of. */
  const logOuting = (o: { at: string; title: string; peopleIds?: string[]; placeId?: string; description?: string }) => {
    const now = new Date().toISOString()
    store.upsert({
      kind: 'task',
      id: crypto.randomUUID(),
      title: o.title,
      description: o.description ?? '',
      status: 'done',
      priority: 'normal',
      completedAt: o.at,
      createdAt: now,
      updatedAt: now,
      tags: ['visit'],
      peopleIds: o.peopleIds?.length ? o.peopleIds : undefined,
      placeId: o.placeId,
    })
    const who = (o.peopleIds ?? []).map(id => store.people.find(p => p.id === id)?.name).filter(Boolean)
    const where = o.placeId ? store.places.find(p => p.id === o.placeId)?.name : undefined
    const bits = [where, who.length ? `with ${who.join(', ')}` : ''].filter(Boolean)
    showToast(bits.length ? `Logged ${bits.join(' ')}` : `Logged “${o.title}”`)
  }
  const logVisit = (person: Person, atIso: string, note: string, placeId?: string) => {
    const placeName = placeId ? store.places.find(p => p.id === placeId)?.name : undefined
    logOuting({
      at: atIso,
      title: note || (placeName ? `${person.name} at ${placeName}` : `Saw ${person.name}`),
      peopleIds: [person.id],
      placeId,
    })
  }
  const planOccasion = (person: Person, kind: 'birthday' | 'anniversary', at: Date) => {
    const due = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 5, 9, 0, 0)
    newTask({
      title: `Gift for ${person.name}'s ${kind}`,
      status: 'todo',
      priority: 'high',
      dueAt: (due.getTime() > Date.now() ? due : new Date(Date.now() + 3_600_000)).toISOString(),
      peopleIds: [person.id],
      tags: ['gift', kind],
      notes: person.notes ? `Ideas from their notes: ${person.notes}` : undefined,
    })
  }
  const [attendance, setAttendance] = useState<CalendarEvent | null>(null)
  const logAttendance = (ev: CalendarEvent, peopleIds: string[]) => {
    if (peopleIds.length === 0) return
    const at = ev.allDay ? new Date(`${ev.start}T12:00`).toISOString() : new Date(ev.start).toISOString()
    logOuting({
      at,
      title: ev.title,
      description: ev.location ? `At ${ev.location}` : '',
      peopleIds,
    })
  }
  const planWith = (person: Person, title?: string) => newTask({ title: title ?? `Catch up with ${person.name}`, status: 'todo', peopleIds: [person.id], tags: ['visit'] })
  const planAt = (place: Place) => newTask({ title: `Go to ${place.name}`, status: 'todo', placeId: place.id, tags: ['visit'] })
  /** Turn an external event into a prep task due the morning before. */
  const planForEvent = (ev: CalendarEvent) => {
    const when = eventStartDate(ev).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    newTask({
      title: `Prep: ${ev.title}`,
      status: 'todo',
      dueAt: prepDueFor(ev),
      notes: `For “${ev.title}” on ${when}${ev.location ? ` · ${ev.location}` : ''}`,
    })
  }
  const newProject = () => setProjectEditor({})

  const deleteTask = (t: Task) => {
    store.remove(t.id)
    setEditor(null)
    showToast(`Deleted “${t.title || 'Untitled'}”`, () => store.restore([t.id]))
  }

  const deleteProject = (p: Project) => {
    const count = store.tasks.filter(t => t.projectId === p.id).length
    if (count > 0 && !window.confirm(`Delete “${p.name}”? Its ${count} task${count === 1 ? '' : 's'} stay, unassigned.`)) return
    store.remove(p.id)
    setProjectEditor(null)
    if (activeFilter === p.id) setProjectFilter('all')
    showToast(`Deleted project “${p.name}”`, () => store.restore([p.id]))
  }

  /** Done in Drafter closes the linked GitHub issue (when the host can write). Quiet on failure. */
  const closeLinkedIssue = (t: Task) => {
    const ref = parseGithubUrl(t.githubUrl)
    if (ref?.type === 'issue') setIssueState(t.githubUrl!, 'close').then(() => showToast(`Closed ${ref.owner}/${ref.repo}#${ref.number} on GitHub`)).catch(() => {})
  }

  const changeStatus = (id: string, status: TaskStatus) => {
    const change = store.setStatus(id, status)
    if (!change) return
    if (status === 'done' && change.prev.status !== 'done') closeLinkedIssue(change.prev)
    showToast(`Moved to ${STATUS_META[status].label}`, () => {
      store.upsert({ ...change.prev, updatedAt: newerStamp(change.prev.updatedAt) })
      if (change.spawnedId) store.remove(change.spawnedId)
    })
  }

  const reschedule = (id: string, day: Date) => {
    const t = store.tasks.find(x => x.id === id)
    if (!t || t.status === 'done') return null
    const prev = { ...t }
    const old = t.dueAt ? new Date(t.dueAt) : null
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old?.getHours() ?? 9, old?.getMinutes() ?? 0)
    store.upsert({
      ...t,
      status: t.status === 'wishlist' || t.status === 'canceled' ? 'todo' : t.status,
      dueAt: at.toISOString(),
      updatedAt: newerStamp(t.updatedAt),
    })
    return prev
  }

  const defer = (id: string, day: Date) => {
    const prev = reschedule(id, day)
    if (!prev) return
    const label = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    showToast(`Moved to ${label}`, () => store.upsert({ ...prev, updatedAt: newerStamp(prev.updatedAt) }))
  }

  const deferAll = (ids: string[], day: Date) => {
    const undos: Task[] = []
    for (const id of ids) {
      const prev = reschedule(id, day)
      if (prev) undos.push(prev)
    }
    if (!undos.length) return
    const label = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    showToast(`Moved ${undos.length} to ${label}`, () => {
      for (const p of undos) store.upsert({ ...p, updatedAt: newerStamp(p.updatedAt) })
    })
  }

  const manualSync = async () => {
    setSyncing(true)
    await store.syncNowManual()
    setSyncing(false)
  }

  const filterProject = activeFilter !== 'all' ? projectMap.get(activeFilter) : undefined

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✈</span>
          <span>Drafter</span>
        </div>
        <nav className="tabs">
          {(Object.keys(VIEW_LABELS) as View[])
            .filter(v => v !== 'social' || hasSocial)
            .map(v => (
              <button key={v} className={view === v ? 'tab active' : 'tab'} onClick={() => setView(v)}>
                {VIEW_LABELS[v]}
              </button>
            ))}
        </nav>
        <span className="spacer" />
        <button className="sync-btn" onClick={manualSync} aria-label={store.syncInfo.online ? 'Synced — tap to sync now' : 'Offline — tap to retry'}>
          <span className={store.syncInfo.online ? 'sync-dot on' : 'sync-dot'} />
          <span className="sync-label">
            {syncing ? 'Syncing…' : store.syncInfo.pending ? `${store.syncInfo.pending} unsynced` : store.syncInfo.lastAt ? timeAgo(store.syncInfo.lastAt).replace(' ago', '') : 'sync'}
          </span>
        </button>
        <button className="btn subtle" aria-label="Search (Cmd/Ctrl+K)" title="Search (Cmd/Ctrl+K)" onClick={() => setSearchOpen(true)}>
          🔍
        </button>
        <button className="btn subtle" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        {isOwner && (
          <button className="btn subtle" aria-label="Admin" title="Admin" onClick={() => setAdminOpen(true)}>
            Admin
          </button>
        )}
        <button className="btn primary new-post-btn" onClick={() => newTask()}>
          + New task
        </button>
      </header>

      {store.loaded && (
        <div className="project-bar" role="tablist" aria-label="Projects">
          <button className={activeFilter === 'all' ? 'pchip on' : 'pchip'} onClick={() => setProjectFilter('all')}>
            All projects
          </button>
          {barProjects.map(p => (
            <button
              key={p.id}
              className={activeFilter === p.id ? 'pchip on' : 'pchip'}
              onClick={() => setProjectFilter(p.id)}
              onDoubleClick={() => openProject(p)}
              title="Click to filter · double-click to edit"
            >
              <span className="pdot" style={{ background: p.color }} />
              {p.emoji && <span className="pchip-emoji">{p.emoji}</span>}
              <span className="pchip-name">{p.name}</span>
            </button>
          ))}
          {filterProject && (
            <>
              <button className="pchip edit" onClick={() => openProject(filterProject)} aria-label="Edit project">
                ✎
              </button>
            </>
          )}
          <button className="pchip add" onClick={newProject}>
            + Project
          </button>
          {inHousehold && (
            <span className="segmented mine-seg">
              <button className={mineOnly ? 'seg on' : 'seg'} onClick={() => setMineOnly(true)}>
                Mine
              </button>
              <button className={!mineOnly ? 'seg on' : 'seg'} onClick={() => setMineOnly(false)}>
                Everyone
              </button>
            </span>
          )}
        </div>
      )}

      {store.syncInfo.authError && (
        <div className="auth-banner">
          Your session expired — changes are staying on this device only.
          <button
            className="btn"
            onClick={async () => {
              await getSupabase()?.auth.signOut()
              await clearLocalData()
              window.location.reload()
            }}
          >
            Sign in again
          </button>
        </div>
      )}

      <main className="content">
        {store.loaded && (
          <ErrorBoundary where={VIEW_LABELS[view]} resetKey={view}>
            {view === 'today' && (
              <Today
                tasks={filteredTasks}
                allTasks={store.tasks}
                people={store.people}
                reviews={store.reviews}
                onPlanWith={planWith}
                onPlanOccasion={planOccasion}
                onSaw={sawThem}
                onSaveReview={r => store.upsert(r)}
                projects={filterProject ? [filterProject] : store.projects}
                projectMap={projectMap}
                events={calendars.events}
                sourceMap={sourceMap}
                onPlan={planForEvent}
                onOpen={openTask}
                onOpenProject={openProject}
                onStatus={changeStatus}
                onDefer={defer}
                onDeferAll={deferAll}
                onNew={newTask}
              />
            )}
            {view === 'board' && (
              <Board
                tasks={filteredTasks}
                projects={projectMap}
                members={household.info?.members ?? []}
                showProject={activeFilter === 'all'}
                onOpen={openTask}
                onStatus={changeStatus}
                onNew={s => newTask({ status: s })}
              />
            )}
            {view === 'calendar' && (
              <>
                <div className="segmented cal-mode" role="tablist" aria-label="Calendar mode">
                  <button className={calMode === 'month' ? 'seg on' : 'seg'} onClick={() => setCalMode('month')}>
                    Month
                  </button>
                  <button className={calMode === 'timeline' ? 'seg on' : 'seg'} onClick={() => setCalMode('timeline')}>
                    Timeline
                  </button>
                </div>
                {calMode === 'month' ? (
                  <Calendar
                    tasks={filteredTasks}
                    projectMap={projectMap}
                    events={calendars.events}
                    sourceMap={sourceMap}
                    onOpen={openTask}
                    onNew={d => newTask({ status: 'todo', dueAt: d })}
                    onReschedule={reschedule}
                    onPlan={planForEvent}
                    onAttendance={ev => setAttendance(ev)}
                  />
                ) : (
                  <Roadmap
                    projects={filterProject ? [filterProject] : store.projects}
                    tasks={store.tasks}
                    events={calendars.events}
                    sourceMap={sourceMap}
                    onOpenProject={openProject}
                    onNewProject={newProject}
                    onOpenTask={openTask}
                  />
                )}
              </>
            )}
            {view === 'tasks' && (
              <TasksTable
                store={store}
                tasks={filteredTasks}
                projectMap={projectMap}
                onOpen={openTask}
                onNew={newTask}
                onDelete={deleteTask}
                onOpenTrash={() => setTrashOpen(true)}
                trashCount={store.allItems.filter(i => i.deletedAt).length}
              />
            )}
            {view === 'notes' && (
              <NotesView
                projects={store.projects}
                project={filterProject}
                getLatest={id => store.projects.find(x => x.id === id)}
                onSave={p => store.upsert(p)}
                onSelectProject={id => setProjectFilter(id)}
                onNewProject={newProject}
                onCreateTask={(title, projectId) => newTask({ title, projectId, status: 'todo' })}
              />
            )}
            {view === 'review' && (
              <Review
                tasks={store.tasks}
                projects={store.projects}
                projectMap={projectMap}
                people={store.people}
                reviews={store.reviews}
                onSaveReview={r => store.upsert(r)}
                onOpen={openTask}
                onStatus={changeStatus}
                onReschedule={(ids, dueAt) => {
                  for (const id of ids) {
                    const t = store.tasks.find(x => x.id === id)
                    if (t) store.upsert({ ...t, dueAt, status: t.status === 'wishlist' ? 'todo' : t.status, updatedAt: newerStamp(t.updatedAt) })
                  }
                  showToast(`Moved ${ids.length} task${ids.length === 1 ? '' : 's'} to Monday`)
                }}
                onOpenProject={openProject}
                onNew={preset => newTask(preset)}
              />
            )}
            {view === 'people' && (
              <>
                <div className="people-tab-seg" style={{ padding: '0.5rem 0 0' }}>
                  <span className="segmented">
                    <button
                      type="button"
                      className={peopleTab === 'people' ? 'seg on' : 'seg'}
                      onClick={() => {
                        setPeopleTab('people')
                        try {
                          localStorage.setItem(PEOPLE_TAB_KEY, 'people')
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      People
                    </button>
                    <button
                      type="button"
                      className={peopleTab === 'places' ? 'seg on' : 'seg'}
                      onClick={() => {
                        setPeopleTab('places')
                        try {
                          localStorage.setItem(PEOPLE_TAB_KEY, 'places')
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      Places
                    </button>
                  </span>
                </div>
                {peopleTab === 'places' ? (
                  <Places
                    places={store.places}
                    people={store.people}
                    tasks={store.tasks}
                    onSave={p => store.upsert(p)}
                    onDelete={id => {
                      store.remove(id)
                      showToast('Removed', () => store.restore([id]))
                    }}
                    onLogOuting={(place, at, note, peopleIds) =>
                      logOuting({
                        at,
                        title: note || `Went to ${place.name}`,
                        placeId: place.id,
                        peopleIds,
                      })
                    }
                    onPlan={planAt}
                    onOpenTask={openTask}
                  />
                ) : (
                  <People
                    people={store.people}
                    places={store.places}
                    tasks={store.tasks}
                    onSave={p => store.upsert(p)}
                    onDelete={id => {
                      store.remove(id)
                      showToast('Removed', () => store.restore([id]))
                    }}
                    onSavePlace={p => store.upsert(p)}
                    onLogVisit={logVisit}
                    onPlan={planWith}
                    onOpenTask={openTask}
                  />
                )}
              </>
            )}
            {view === 'social' && (
              <Suspense fallback={<p className="empty">Loading insights…</p>}>
                <Insights posts={posts} />
              </Suspense>
            )}
          </ErrorBoundary>
        )}
      </main>

      {editor && (
        <TaskEditor
          task={editor.task}
          preset={editor.preset}
          capture={editor.capture}
          projects={store.projects}
          people={store.people}
          places={store.places}
          onSavePlace={p => store.upsert(p)}
          members={inHousehold ? household.info!.members : []}
          candidates={store.tasks.filter(t => t.status !== 'canceled' && t.id !== editor.task?.id && (!editor.task?.projectId || t.projectId === editor.task.projectId))}
          getLatest={id => store.tasks.find(x => x.id === id)}
          onSave={t => {
            const before = store.tasks.find(x => x.id === t.id)
            const isNew = !before
            store.upsert(t)
            setEditor(null)
            if (isNew) showToast(`Added “${t.title || 'Untitled'}”`, () => store.remove(t.id))
            if (t.status === 'done' && before?.status !== 'done') closeLinkedIssue(t)
          }}
          onDiscard={() => showToast('Nothing to save — that task was empty.')}
          onCommit={t => store.upsert(t)}
          onDelete={id => {
            const t = store.tasks.find(x => x.id === id)
            if (t) deleteTask(t)
          }}
          onClose={() => setEditor(null)}
        />
      )}

      {projectEditor && (
        <ProjectEditor
          project={projectEditor.project}
          tasks={projectEditor.project ? store.tasks.filter(t => t.projectId === projectEditor.project!.id) : []}
          getLatest={id => store.projects.find(x => x.id === id)}
          onSave={p => {
            store.upsert(p)
            setProjectEditor(null)
            if (!projectEditor.project) setProjectFilter(p.id)
          }}
          onDelete={id => {
            const p = store.projects.find(x => x.id === id)
            if (p) deleteProject(p)
          }}
          onClose={() => setProjectEditor(null)}
          onOpenNotes={p => {
            setProjectEditor(null)
            setProjectFilter(p.id)
            setView('notes')
          }}
          templates={store.templates}
          onCreateMany={(p, ts) => {
            store.upsert(p)
            for (const t of ts) store.upsert(t)
            setProjectEditor(null)
            setProjectFilter(p.id)
            showToast(`${projectEditor.project ? 'Added' : 'Created'} ${ts.length} task${ts.length === 1 ? '' : 's'} in “${p.name}”`)
          }}
          onSaveTemplate={t => {
            store.upsert(t)
            showToast(`Template “${t.name}” saved — pick it when creating a project`)
          }}
        />
      )}

      {attendance && (
        <AttendancePicker
          event={attendance}
          people={store.people}
          onDone={ids => {
            logAttendance(attendance, ids)
            setAttendance(null)
          }}
          onClose={() => setAttendance(null)}
        />
      )}

      {searchOpen && (
        <Search
          tasks={store.tasks}
          projects={store.projects}
          people={store.people}
          onOpenTask={openTask}
          onOpenProject={openProject}
          onOpenPerson={() => setView('people')}
          onSaw={sawThem}
          onCreateTask={(title, openEditor) => {
            // always open the editor so parseCapture can propose fields; Shift+Enter same path
            void openEditor
            newTask({ title, status: 'todo' }, { capture: true })
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {trashOpen && (
        <Trash
          items={store.allItems}
          projectMap={projectMap}
          onRestore={id => {
            store.restore([id])
            showToast('Restored')
          }}
          onPurge={id => {
            store.purge([id]).then(
              () => showToast('Deleted forever'),
              e => showToast(`Removed here, but the server refused: ${(e as Error).message}`),
            )
          }}
          onClose={() => setTrashOpen(false)}
        />
      )}

      {settingsOpen && <Settings key={settingsNonce} store={store} calendars={calendars} googlePush={googlePush} microsoftSync={microsoftSync} household={household} onClose={() => setSettingsOpen(false)} />}
      {adminOpen && isOwner && <Admin onClose={() => setAdminOpen(false)} />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.undo && (
            <button
              className="toast-undo"
              onClick={() => {
                toast.undo?.()
                setToast(null)
              }}
            >
              Undo
            </button>
          )}
          <button className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
