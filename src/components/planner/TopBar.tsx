import { timeAgo } from '../../utils'
import { Icon } from '../Icon'
import type { PlannerCtx } from './ctx'
import { COMPACT_TABS, VIEW_ICONS, VIEW_LABELS, type View } from './routes'

/**
 * The header: the name, the five tabs (a strip on the desktop, the bar at the
 * foot of the phone), the sync pill, search, settings, Admin and New task.
 */
export function TopBar({ p }: { p: PlannerCtx }) {
  const { view, goView, store, syncing, manualSync, setSearchOpen, setSettingsOpen, isOwner, setAdminOpen, newTask } = p
  return (
    <header className="topbar">
      {/* the phone hides the wordmark span for width (src/styles/08-responsive.css), so the
          name lives on the container and the glyph is decorative — otherwise
          VoiceOver announces the header as "airplane". */}
      <div className="brand" aria-label="Drafter">
        <span className="brand-mark" aria-hidden>
          <Icon name="brand" filled strokeWidth={0} />
        </span>
        <span>Drafter</span>
      </div>
      <nav className="tabs tabs-full" aria-label="Views">
        {(Object.keys(VIEW_LABELS) as View[]).map(v => (
          <button key={v} className={view === v ? 'tab active' : 'tab'} onClick={() => goView(v)}>
            <span className="tab-icon" aria-hidden>
              <Icon name={VIEW_ICONS[v]} />
            </span>
            {VIEW_LABELS[v]}
          </button>
        ))}
      </nav>
      <nav className="tabs tabs-compact" aria-label="Main">
        {COMPACT_TABS.map(t => {
          const active = view === t.id
          return (
            <button
              key={t.id}
              type="button"
              className={active ? 'tab active' : 'tab'}
              aria-current={active ? 'page' : undefined}
              onClick={() => goView(t.id)}
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
      <button className="sync-btn" onClick={manualSync} aria-label={store.syncInfo.online ? 'Synced — tap to sync now' : 'Offline — tap to retry'}>
        <span className={store.syncInfo.online ? 'sync-dot on' : 'sync-dot'} />
        <span className="sync-label">
          {syncing ? 'Syncing…' : store.syncInfo.pending ? `${store.syncInfo.pending} unsynced` : store.syncInfo.lastAt ? timeAgo(store.syncInfo.lastAt).replace(' ago', '') : 'sync'}
        </span>
      </button>
      <button className="btn subtle icon-btn" aria-label="Search (Cmd/Ctrl+K)" title="Search (Cmd/Ctrl+K)" onClick={() => setSearchOpen(true)}>
        <Icon name="search" size={19} />
      </button>
      <button className="btn subtle icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
        <Icon name="settings" size={19} />
      </button>
      {/* hidden below 640px (it pushed "+ New task" off a 375pt header) —
          the phone route is the Admin row in Settings ▸ Data */}
      {isOwner && (
        <button className="btn subtle admin-btn" aria-label="Admin" title="Admin" onClick={() => setAdminOpen(true)}>
          Admin
        </button>
      )}
      <button className="btn primary new-post-btn" onClick={() => newTask()} aria-label="New task" title="New task">
        <span className="new-post-plus" aria-hidden>
          <Icon name="plus" size={18} strokeWidth={2.2} />
        </span>
        <span className="new-post-label">New task</span>
      </button>
    </header>
  )
}
