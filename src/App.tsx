import { useEffect, useRef, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import { Post } from './types'
import { usePosts } from './store'
import { initBackup } from './backup'
import { notifyDue } from './notify'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { Board } from './components/Board'
import { Calendar } from './components/Calendar'
import { Dashboard } from './components/Dashboard'
import { PostsTable } from './components/PostsTable'
import { Insights } from './components/Insights'
import { Composer } from './components/Composer'
import { Landing } from './components/Landing'
import { Login } from './components/Login'
import { Settings } from './components/Settings'

type View = 'dashboard' | 'board' | 'calendar' | 'posts' | 'insights'

const VIEW_LABELS: Record<View, string> = {
  dashboard: 'Dashboard',
  board: 'Board',
  calendar: 'Calendar',
  posts: 'Posts',
  insights: 'Insights',
}

interface Toast {
  msg: string
  undo?: () => void
}

/** Local mode is for private hosts only — a public deploy without a backend fails closed. */
function isPrivateHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localhost') ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  )
}

/** Gate: public visitors see the landing page; the planner mounts only after sign-in. */
export default function App() {
  const supabaseOn = isSupabaseConfigured()
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabaseOn)
  const [showLogin, setShowLogin] = useState(false)

  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthReady(true)
    })
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!authReady) return null
  // fail closed: a public deploy with no backend gets the landing page with sign-in hidden
  if (!supabaseOn && import.meta.env.PROD && !isPrivateHost(window.location.hostname)) {
    return <Landing configured={false} />
  }
  if (supabaseOn && !session) {
    return showLogin ? <Login onBack={() => setShowLogin(false)} /> : <Landing configured onSignIn={() => setShowLogin(true)} />
  }
  return <Planner />
}

function Planner() {
  const store = usePosts()
  const [view, setView] = useState<View>('dashboard')
  const [composer, setComposer] = useState<{ post?: Post; preset?: Partial<Post> } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = (msg: string, undo?: () => void) => {
    window.clearTimeout(toastTimer.current)
    setToast({ msg, undo })
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }

  // warm the backup handle so auto-backup resumes without opening Settings
  useEffect(() => {
    initBackup()
  }, [])

  // due-post reminders while the app is open
  const notifyRef = useRef(() => {})
  notifyRef.current = () => notifyDue(store.posts, store.markNotified)
  useEffect(() => {
    notifyRef.current()
    const t = window.setInterval(() => notifyRef.current(), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const openPost = (post: Post) => setComposer({ post })
  const newPost = (preset?: Partial<Post>) => setComposer({ preset })

  const deletePost = (p: Post) => {
    store.remove(p.id)
    setComposer(null)
    showToast(`Deleted “${p.title || 'Untitled'}”`, () => store.restore([p.id]))
  }

  const reschedule = (id: string, day: Date) => {
    const p = store.posts.find(x => x.id === id)
    if (!p || p.status === 'posted') return
    const old = p.scheduledFor ? new Date(p.scheduledFor) : null
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old?.getHours() ?? 9, old?.getMinutes() ?? 0)
    store.upsert({
      ...p,
      status: 'scheduled',
      scheduledFor: at.toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

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
        <span
          className={store.syncInfo.online ? 'sync-dot on' : 'sync-dot'}
          title={store.syncInfo.online ? 'Sync connected' : 'Sync offline (local only)'}
        />
        <button className="btn subtle" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        <button className="btn primary" onClick={() => newPost()}>
          + New post
        </button>
      </header>

      <main className="content">
        {view === 'dashboard' && <Dashboard posts={store.posts} onOpen={openPost} />}
        {view === 'board' && (
          <Board posts={store.posts} onOpen={openPost} onStatus={store.setStatus} onNew={s => newPost({ status: s })} />
        )}
        {view === 'calendar' && (
          <Calendar
            posts={store.posts}
            onOpen={openPost}
            onNew={d => newPost({ status: 'scheduled', scheduledFor: d })}
            onReschedule={reschedule}
          />
        )}
        {view === 'posts' && <PostsTable store={store} onOpen={openPost} onNew={newPost} onDelete={deletePost} />}
        {view === 'insights' && <Insights posts={store.posts} />}
      </main>

      {composer && (
        <Composer
          post={composer.post}
          preset={composer.preset}
          onSave={p => {
            store.upsert(p)
            setComposer(null)
          }}
          onDelete={id => {
            const p = store.posts.find(x => x.id === id)
            if (p) deletePost(p)
          }}
          onClose={() => setComposer(null)}
        />
      )}

      {settingsOpen && <Settings store={store} onClose={() => setSettingsOpen(false)} />}

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
