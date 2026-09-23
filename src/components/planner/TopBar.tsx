import { unreadSince } from '../../chat'
import { warm } from '../../lazyload'
import { isSupabaseConfigured } from '../../supabase'
import { syncPillLabel } from '../../sync'
import { timeAgo } from '../../utils'
import { Icon } from '../Icon'
import type { PlannerCtx } from './ctx'
import { Chat, Search, Settings, TaskEditor, preloadView } from './lazy'
import { COMPACT_TABS, VIEW_ICONS, VIEW_LABELS, type View } from './routes'

/**
 * The header: the name, the six tabs (a strip on the desktop, the bar at the
 * foot of the phone), the sync pill, search, settings, Admin and New task.
 * A finger landing on a tab or a button (or focus reaching it) starts fetching
 * what it opens, so the tap that follows finds it here.
 */
export function TopBar({ p }: { p: PlannerCtx }) {
  const { view, goView, store, syncing, manualSync, setSearchOpen, setPushed, pushed, chatSeenAt, household, isOwner, setAdminOpen, newTask } = p
  const unread = unreadSince(store.messages, chatSeenAt, household.myId)
  /** A tab tap leaves whatever screen was pushed over it — that is what a tab means. */
  const goTab = (v: View) => {
    setPushed(null)
    goView(v)
  }
  const warmSearch = () => warm(Search.preload)
  const warmSettings = () => warm(Settings.preload)
  const warmChat = () => warm(Chat.preload)
  const warmEditor = () => warm(TaskEditor.preload)
  // what the pill says: synced, offline, the server failing, or the session gone — never "Offline" on a working connection
  const syncLabel = syncPillLabel(isSupabaseConfigured(), store.syncInfo)
  return (
    <header className="topbar">
      {/* the phone and the compact landscape header hide the wordmark span for
          width (src/styles/08-responsive.css), so the name lives on the
          container and the glyph is decorative — otherwise VoiceOver announces
          the header as "airplane". */}
      <div className="brand" aria-label="Drafter">
        {/* The app's own icon, not a glyph that looks like it. The header drew
            a "D" while every icon file was a paper aeroplane, which is how the
            comment above came to warn that VoiceOver says "airplane"; pointing
            this at /icon.svg is the only way the two cannot drift again. */}
        <img className="brand-mark" src="/icon.svg" alt="" width={28} height={28} aria-hidden />
        <span>Drafter</span>
      </div>
      <nav className="tabs tabs-full" aria-label="Views">
        {(Object.keys(VIEW_LABELS) as View[]).map(v => (
          <button
            key={v}
            type="button"
            className={view === v && !pushed ? 'tab active' : 'tab'}
            aria-current={view === v && !pushed ? 'page' : undefined}
            onClick={() => goTab(v)}
            onPointerDown={() => preloadView(v)}
            onFocus={() => preloadView(v)}
          >
            <span className="tab-icon" aria-hidden>
              <Icon name={VIEW_ICONS[v]} />
            </span>
            {/* hidden to the eye on a compact header (landscape phones, src/styles/08-responsive.css); still the tab's name */}
            <span className="tab-label">{VIEW_LABELS[v]}</span>
          </button>
        ))}
      </nav>
      <nav className="tabs tabs-compact" aria-label="Main">
        {COMPACT_TABS.map(t => {
          // a pushed screen is over the tab, so no tab is the one you are on
          const active = view === t.id && !pushed
          return (
            <button
              key={t.id}
              type="button"
              className={active ? 'tab active' : 'tab'}
              aria-current={active ? 'page' : undefined}
              onClick={() => goTab(t.id)}
              onPointerDown={() => preloadView(t.id)}
              onFocus={() => preloadView(t.id)}
            >
              <span className="tab-icon" aria-hidden>
                <Icon name={t.icon} />
              </span>
              <span className="tab-label">{t.label}</span>
            </button>
          )
        })}
      </nav>
      <span className="spacer" />
      {/* local mode (no Supabase env) has no account to sync with: the pill
          says where the data is, not that the network is down */}
      <button className="sync-btn" onClick={manualSync} aria-label={syncLabel} title={syncLabel}>
        <span className={store.syncInfo.online ? 'sync-dot on' : store.syncInfo.problem === 'server' ? 'sync-dot warn' : 'sync-dot'} />
        <span className="sync-label">
          {syncing ? 'Syncing…' : store.syncInfo.pending ? `${store.syncInfo.pending} unsynced` : store.syncInfo.lastAt ? timeAgo(store.syncInfo.lastAt).replace(' ago', '') : 'sync'}
        </span>
      </button>
      <button
        className="btn subtle icon-btn"
        aria-label="Search (Cmd/Ctrl+K)"
        title="Search (Cmd/Ctrl+K)"
        onClick={() => setSearchOpen(true)}
        onPointerDown={warmSearch}
        onFocus={warmSearch}
      >
        <Icon name="search" size={19} />
      </button>
      {/* The chat sits with Search rather than in a tab: the household half is
          a thread somebody else writes to, so its badge has to be visible from
          wherever you are, and the assistant half is a thing you summon. The
          palette has reached the assistant by name all along ("Ask Drafter");
          this is the door the thread never had (v3.29). */}
      <button
        className="btn subtle icon-btn chat-btn"
        aria-label={unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
        title="Chat"
        onClick={() => setPushed('chat')}
        onPointerDown={warmChat}
        onFocus={warmChat}
      >
        <Icon name="chat" size={19} />
        {unread > 0 && <span className="chat-dot" aria-hidden />}
      </button>
      <button className="btn subtle icon-btn" aria-label="Settings" onClick={() => setPushed('settings')} onPointerDown={warmSettings} onFocus={warmSettings}>
        <Icon name="settings" size={19} />
      </button>
      {/* hidden below 640px (it pushed "+ New task" off a 375pt header) —
          the phone route is the Admin row in Settings ▸ Data */}
      {isOwner && (
        <button className="btn subtle admin-btn" aria-label="Admin" title="Admin" onClick={() => setAdminOpen(true)}>
          Admin
        </button>
      )}
      <button className="btn primary new-post-btn" onClick={() => newTask()} onPointerDown={warmEditor} onFocus={warmEditor} aria-label="New task" title="New task">
        <span className="new-post-plus" aria-hidden>
          <Icon name="plus" size={18} strokeWidth={2.2} />
        </span>
        <span className="new-post-label">New task</span>
      </button>
    </header>
  )
}
