import { useEffect, useRef, useState } from 'react'
import { Post, STATUS_META, Status } from '../types'
import { usePosts } from '../store'
import { newerStamp } from '../postops'
import { notifyDue } from '../notify'
import { getSupabase } from '../supabase'
import { timeAgo } from '../utils'
import { Board } from './Board'
import { Calendar } from './Calendar'
import { Dashboard } from './Dashboard'
import { PostsTable } from './PostsTable'
import { Insights } from './Insights'
import { Composer } from './Composer'
import { Settings } from './Settings'

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

export default function Planner() {
  const store = usePosts()
  const [view, setView] = useState<View>('dashboard')
  const [composer, setComposer] = useState<{ post?: Post; preset?: Partial<Post> } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [syncing, setSyncing] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = (msg: string, undo?: () => void) => {
    window.clearTimeout(toastTimer.current)
    setToast({ msg, undo })
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }

  // due-post reminders while the app is open (device-local, never a store write)
  const notifyRef = useRef(() => {})
  notifyRef.current = () => {
    notifyDue(store.posts)
  }
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

  const changeStatus = (id: string, status: Status) => {
    const change = store.setStatus(id, status)
    if (!change) return
    showToast(`Moved to ${STATUS_META[status].label}`, () => {
      store.upsert({ ...change.prev, updatedAt: newerStamp(change.prev.updatedAt) })
      if (change.spawnedId) store.remove(change.spawnedId)
    })
  }

  const reschedule = (id: string, day: Date) => {
    const p = store.posts.find(x => x.id === id)
    if (!p || p.status === 'posted') return
    const old = p.scheduledFor ? new Date(p.scheduledFor) : null
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old?.getHours() ?? 9, old?.getMinutes() ?? 0)
    store.upsert({ ...p, status: 'scheduled', scheduledFor: at.toISOString(), updatedAt: newerStamp(p.updatedAt) })
  }

  const manualSync = async () => {
    setSyncing(true)
    await store.syncNowManual()
    setSyncing(false)
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
        <button
          className="sync-btn"
          onClick={manualSync}
          aria-label={store.syncInfo.online ? 'Synced — tap to sync now' : 'Offline — tap to retry'}
        >
          <span className={store.syncInfo.online ? 'sync-dot on' : 'sync-dot'} />
          <span className="sync-label">
            {syncing ? 'Syncing…' : store.syncInfo.lastAt ? timeAgo(store.syncInfo.lastAt).replace(' ago', '') : 'sync'}
          </span>
        </button>
        <button className="btn subtle" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        <button className="btn primary new-post-btn" onClick={() => newPost()}>
          + New post
        </button>
      </header>

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
            {view === 'dashboard' && <Dashboard posts={store.posts} onOpen={openPost} />}
            {view === 'board' && (
              <Board posts={store.posts} onOpen={openPost} onStatus={changeStatus} onNew={s => newPost({ status: s })} />
            )}
            {view === 'calendar' && (
              <Calendar
                posts={store.posts}
                onOpen={openPost}
                onNew={d => newPost({ status: 'scheduled', scheduledFor: d })}
                onReschedule={reschedule}
              />
            )}
            {view === 'posts' && (
              <PostsTable store={store} onOpen={openPost} onNew={newPost} onDelete={deletePost} />
            )}
            {view === 'insights' && <Insights posts={store.posts} />}
          </>
        )}
      </main>

      {composer && (
        <Composer
          post={composer.post}
          preset={composer.preset}
          getLatest={id => store.posts.find(x => x.id === id)}
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
