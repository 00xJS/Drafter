import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarEvent, Person, Post, Project, STATUS_META, Task, TaskStatus, toPost } from '../types'
import { useItems } from '../store'
import { newerStamp } from '../itemops'
import { notifyDue } from '../notify'
import { getSupabase } from '../supabase'
import { clearLocalData } from '../idb'
import { projectById } from '../taskutils'
import { GOOGLE_PUSH_ID, eventStartDate, prepDueFor, useCalendarEvents, useGooglePush, useMicrosoftSync } from '../calendars'
import { parseGithubUrl, setIssueState } from '../github'
import { useHousehold } from '../household'
import { timeAgo } from '../utils'
import { Board } from './Board'
import { Calendar } from './Calendar'
import { Today } from './Today'
import { Roadmap } from './Roadmap'
import { TasksTable } from './TasksTable'
import { Insights } from './Insights'
import { People } from './People'
import { Review } from './Review'
import { Search } from './Search'
import { AttendancePicker } from './AttendancePicker'
import { TaskEditor } from './TaskEditor'
import { ProjectEditor } from './ProjectEditor'
import { NotesView } from './NotesView'
import { Trash } from './Trash'
import { Settings } from './Settings'
import { ErrorBoundary } from './ErrorBoundary'

type View = 'today' | 'tasks' | 'board' | 'calendar' | 'notes' | 'people' | 'review' | 'social'
type CalendarMode = 'month' | 'timeline'

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
  const [editor, setEditor] = useState<{ task?: Task; preset?: Partial<Task> } | null>(null)
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
  const mirroring = store.calendars.some(c => c.id === GOOGLE_PUSH_ID && c.enabled)
  const msMirrorIds = useMemo(
    () => store.calendars.filter(c => c.enabled && c.url.startsWith('ms-push:')).map(c => c.url.slice('ms-push:'.length)),
    [store.calendars],
  )
  const googlePush = useGooglePush(store.allItems, store.projects, store.loaded && mirroring, changes =>
    applyMirrorChanges(changes, 'Google Calendar'),
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

  // shared into the app (PWA share target) or opened with ?new=
  useEffect(() => {
    if (!store.loaded) return
    const params = new URLSearchParams(window.location.search)
    const title = params.get('title') ?? params.get('new')
    const text = params.get('text')
    const url = params.get('url')
    if (!title && !text && !url) return
    window.history.replaceState({}, '', window.location.pathname)
    const looksLikeUrl = (s: string | null) => !!s && /^https?:\/\//.test(s)
    const link = url ?? (looksLikeUrl(text) ? text! : undefined)
    setEditor({ preset: { title: (title ?? (looksLikeUrl(text) ? '' : text) ?? '').slice(0, 140), description: text && text !== link ? text : '', link, status: 'todo' } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.loaded])

  /** A mirrored task moved (or was deleted) in an external calendar. */
  const applyMirrorChanges = (changes: { taskId: string; deleted: boolean; start: string | null; updated: string }[], source: string) => {
    let moved = 0
    for (const c of changes) {
      const t = store.tasks.find(x => x.id === c.taskId)
      if (!t || c.updated <= t.updatedAt || c.deleted || !c.start) continue
      const next = new Date(c.start).toISOString()
      if (next === t.dueAt) continue
      store.upsert({ ...t, dueAt: next, updatedAt: newerStamp(t.updatedAt) })
      moved++
    }
    if (moved) showToast(`${moved} task${moved === 1 ? '' : 's'} moved from ${source}`)
  }

  const microsoftSync = useMicrosoftSync(store.allItems, store.projects, store.loaded ? msMirrorIds : [], changes =>
    applyMirrorChanges(changes, 'Outlook'),
  )

  // back from a calendar consent screen (Google or Microsoft)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ms = params.get('microsoft')
    if (ms) {
      window.history.replaceState({}, '', window.location.pathname)
      showToast(ms === 'connected' ? 'Outlook connected — pick the calendars to show in Settings.' : `Outlook could not be connected (${(params.get('reason') ?? 'unknown error').replace(/_/g, ' ')}).`)
      setSettingsOpen(true)
      return
    }
    const result = params.get('google')
    if (!result) return
    window.history.replaceState({}, '', window.location.pathname)
    if (result === 'connected') {
      showToast('Google Calendar connected — pick the calendars to show in Settings.')
      setSettingsOpen(true)
    } else {
      const reason = params.get('reason') ?? 'unknown error'
      showToast(`Google Calendar could not be connected (${reason.replace(/_/g, ' ')}).`)
      setSettingsOpen(true)
    }
    // eslint-disable-next-line no-useless-return
    return
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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

  const openTask = (task: Task) => setEditor({ task })
  const newTask = (preset?: Partial<Task>) =>
    setEditor({ preset: { ...(activeFilter !== 'all' ? { projectId: activeFilter } : {}), ...preset } })
  const openProject = (project: Project) => setProjectEditor({ project })
  /** A done task dated at the visit is what "seeing someone" is made of. */
  const logVisit = (person: Person, atIso: string, note: string) => {
    const now = new Date().toISOString()
    store.upsert({
      kind: 'task',
      id: crypto.randomUUID(),
      title: note || `Saw ${person.name}`,
      description: '',
      status: 'done',
      priority: 'normal',
      completedAt: atIso,
      createdAt: now,
      updatedAt: now,
      tags: ['visit'],
      peopleIds: [person.id],
    })
    showToast(`Logged a visit with ${person.name}`)
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
    const now = new Date().toISOString()
    const at = ev.allDay ? new Date(`${ev.start}T12:00`).toISOString() : new Date(ev.start).toISOString()
    store.upsert({ kind: 'task', id: crypto.randomUUID(), title: ev.title, description: ev.location ? `At ${ev.location}` : '', status: 'done', priority: 'normal', completedAt: at, createdAt: now, updatedAt: now, tags: ['visit'], peopleIds })
    const names = peopleIds.map(id => store.people.find(p => p.id === id)?.name ?? '').filter(Boolean)
    showToast(`Logged ${names.join(', ')} at “${ev.title}”`)
  }
  const planWith = (person: Person, title?: string) => newTask({ title: title ?? `Catch up with ${person.name}`, status: 'todo', peopleIds: [person.id], tags: ['visit'] })
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
    if (!t || t.status === 'done') return
    const old = t.dueAt ? new Date(t.dueAt) : null
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old?.getHours() ?? 9, old?.getMinutes() ?? 0)
    store.upsert({
      ...t,
      status: t.status === 'wishlist' || t.status === 'canceled' ? 'todo' : t.status,
      dueAt: at.toISOString(),
      updatedAt: newerStamp(t.updatedAt),
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
          <span className="sync-label">{syncing ? 'Syncing…' : store.syncInfo.lastAt ? timeAgo(store.syncInfo.lastAt).replace(' ago', '') : 'sync'}</span>
        </button>
        <button className="btn subtle" aria-label="Search (Cmd/Ctrl+K)" title="Search (Cmd/Ctrl+K)" onClick={() => setSearchOpen(true)}>
          🔍
        </button>
        <button className="btn subtle" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
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
                onPlanWith={planWith}
                onPlanOccasion={planOccasion}
                projects={filterProject ? [filterProject] : store.projects}
                projectMap={projectMap}
                events={calendars.events}
                sourceMap={sourceMap}
                onPlan={planForEvent}
                onOpen={openTask}
                onOpenProject={openProject}
                onStatus={changeStatus}
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
              />
            )}
            {view === 'people' && (
              <People
                people={store.people}
                tasks={store.tasks}
                onSave={p => store.upsert(p)}
                onDelete={id => {
                  store.remove(id)
                  showToast('Removed', () => store.restore([id]))
                }}
                onLogVisit={logVisit}
                onPlan={planWith}
                onOpenTask={openTask}
              />
            )}
            {view === 'social' && <Insights posts={posts} />}
          </ErrorBoundary>
        )}
      </main>

      {editor && (
        <TaskEditor
          task={editor.task}
          preset={editor.preset}
          projects={store.projects}
          people={store.people}
          members={inHousehold ? household.info!.members : []}
          candidates={store.tasks.filter(t => t.status !== 'canceled' && t.id !== editor.task?.id && (!editor.task?.projectId || t.projectId === editor.task.projectId))}
          getLatest={id => store.tasks.find(x => x.id === id)}
          onSave={t => {
            const before = store.tasks.find(x => x.id === t.id)
            store.upsert(t)
            setEditor(null)
            if (t.status === 'done' && before?.status !== 'done') closeLinkedIssue(t)
          }}
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
          onCreateTask={title => newTask({ title, status: 'todo' })}
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

      {settingsOpen && <Settings store={store} calendars={calendars} googlePush={googlePush} microsoftSync={microsoftSync} household={household} onClose={() => setSettingsOpen(false)} />}

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
