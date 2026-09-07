import { Item, Project, STATUS_META, Task } from '../types'
import { excerpt, fmtDateTime, timeAgo } from '../utils'

interface Props {
  items: Item[]
  projectMap: Map<string, Project>
  onRestore(id: string): void
  onClose(): void
}

const RETENTION_DAYS = 90

/** Everything deleted in the last 90 days, restorable with one click. */
export function Trash({ items, projectMap, onRestore, onClose }: Props) {
  const deleted = items.filter(i => i.deletedAt).sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!))
  const label = (i: Item) => (i.kind === 'task' ? i.title || excerpt(i.description, 50) || 'Untitled task' : i.name)
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Trash</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">
          <p className="field-hint">
            Deleted items stay here for {RETENTION_DAYS} days, then disappear for good. Restoring puts everything back exactly as it
            was, on every device.
          </p>
          {deleted.length === 0 ? (
            <p className="empty">The trash is empty.</p>
          ) : (
            <ul className="dash-list trash-list">
              {deleted.map(i => {
                const t = i.kind === 'task' ? (i as Task) : null
                const project = t?.projectId ? projectMap.get(t.projectId) : undefined
                const expires = new Date(new Date(i.deletedAt!).getTime() + RETENTION_DAYS * 86_400_000)
                return (
                  <li key={i.id} className="trash-row">
                    <div className="dash-main">
                      <span className="dash-title">
                        <small className="muted">{i.kind === 'task' ? 'Task' : i.kind === 'project' ? 'Project' : 'Calendar'}</small> {label(i)}
                      </span>
                      <span className="dash-meta">
                        {t && (
                          <span className="badge" style={{ background: STATUS_META[t.status].bg, color: STATUS_META[t.status].color }}>
                            {STATUS_META[t.status].label}
                          </span>
                        )}
                        {project && <small className="muted">{project.name}</small>}
                        <small className="muted">
                          deleted {timeAgo(i.deletedAt!)} · gone {fmtDateTime(expires.toISOString())}
                        </small>
                      </span>
                    </div>
                    <button className="btn" onClick={() => onRestore(i.id)}>
                      Restore
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
