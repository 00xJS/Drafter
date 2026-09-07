import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarEvent, Post, Project, STATUS_META, Task, TaskStatus, toPost } from '../types'
import { useItems } from '../store'
import { newerStamp } from '../itemops'
import { notifyDue } from '../notify'
import { getSupabase } from '../supabase'
import { projectById } from '../taskutils'
import { eventStartDate, prepDueFor, useCalendarEvents } from '../calendars'
import { timeAgo } from '../utils'
import { Board } from './Board'
import { Calendar } from './Calendar'
import { Today } from './Today'
import { Roadmap } from './Roadmap'
import { TasksTable } from './TasksTable'
import { Insights } from './Insights'
import { TaskEditor } from './TaskEditor'
import { ProjectEditor } from './ProjectEditor'
import { Settings } from './Settings'

type View = 'today' | 'tasks' | 'board' | 'calendar' | 'insights'
type CalendarMode = 'month' | 'timeline'

const VIEW_LABELS: Record<View, string> = {
  today: 'Today',
  tasks: 'Tasks',
  board: 'Board',
  calendar: 'Calendar',
  insights: 'Insights',
}

const FILTER_KEY = 'drafter:project-filter'
const CAL_MODE_KEY = 'drafter:calendar-mode'

interface Toast {
  msg: string
  undo?: () => void
}

export default function Planner() {
  const store = useItems()
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
  const activeFilter = projectFilter !== 'all' && projectMap.has(projectFilter) ? projectFilter : 'all'
  const filteredTasks = useMemo(
    () => (activeFilter === 'all' ? store.tasks : store.tasks.filter(t => t.projectId === activeFilter)),
    [store.tasks, activeFilter],
  )
  const posts = useMemo(() => filteredTasks.map(toPost).filter((p): p is Post => p !== null), [filteredTasks])
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

  const changeStatus = (id: string, status: TaskStatus) => {
    const change = store.setStatus(id, status)
    if (!change) return
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
          {(Object.keys(VIEW_LABELS) as View[]).map(v => (
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
            <button className="pchip edit" onClick={() => openProject(filterProject)} aria-label="Edit project">
              ✎
            </button>
          )}
          <button className="pchip add" onClick={newProject}>
            + Project
          </button>
        </div>
      )}

      {store.syncInfo.authError && (
        <div className="auth-banner">
          Your session expired — changes are staying on this device only.
          <button className="btn" onClick={() => getSupabase()?.auth.signOut()}>
            Sign in again
          </button>
        </div>
      )}

      <main className="content">
        {store.loaded && (
          <>
            {view === 'today' && (
              <Today
                tasks={filteredTasks}
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
              <TasksTable store={store} tasks={filteredTasks} projectMap={projectMap} onOpen={openTask} onNew={newTask} onDelete={deleteTask} />
            )}
            {view === 'insights' && <Insights posts={posts} />}
          </>
        )}
      </main>

      {editor && (
        <TaskEditor
          task={editor.task}
          preset={editor.preset}
          projects={store.projects}
          getLatest={id => store.tasks.find(x => x.id === id)}
          onSave={t => {
            store.upsert(t)
            setEditor(null)
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
        />
      )}

      {settingsOpen && <Settings store={store} calendars={calendars} onClose={() => setSettingsOpen(false)} />}

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
