import { Item, Project, STATUS_META, Task } from '../types'
import { inTrash } from '../itemops'
import { htmlToText } from '../richtext'
import { excerpt, fmtDateTime, timeAgo } from '../utils'
import { ConfirmButton } from './ConfirmButton'
import { Modal, ModalHead } from './Modal'

interface Props {
  items: Item[]
  projectMap: Map<string, Project>
  onRestore(id: string): void
  /** Permanent: removes the record from every device and the database. */
  onPurge(id: string): void
  onClose(): void
}

const RETENTION_DAYS = 90

const pieces = (n: number) => `${n} piece${n === 1 ? '' : 's'}`

function kindLabel(kind: Item['kind']): string {
  switch (kind) {
    case 'task':
      return 'Task'
    case 'project':
      return 'Project'
    case 'person':
      return 'Person'
    case 'place':
      return 'Place'
    case 'recipe':
      return 'Recipe'
    case 'meal':
      return 'Meal'
    case 'grocery':
      return 'Grocery list'
    case 'journal':
      return 'Journal entry'
    case 'review':
      return 'Review'
    case 'template':
      return 'Template'
    case 'calendar':
      return 'Calendar'
    case 'event':
      return 'Event'
    case 'habit':
      return 'Habit'
    case 'routine':
      return 'Routine'
    case 'note':
      return 'Note'
    case 'garment':
      return 'Clothing'
    case 'outfit':
      return 'Outfit'
    case 'wear':
      return 'Outfit worn'
    case 'snooze':
      return 'Nudge put off'
    case 'message':
      return 'Message'
    case 'chat':
      return 'Chat'
    case 'account':
      return 'Account'
  }
}

/** Everything deleted in the last 90 days, restorable with one click. */
export function Trash({ items, projectMap, onRestore, onPurge, onClose }: Props) {
  const deleted = items.filter(inTrash).sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!))
  const label = (i: Item) =>
    i.kind === 'task'
      ? i.title || excerpt(i.description, 50) || 'Untitled task'
      : i.kind === 'review'
        ? `${i.period} ${i.key}`
        : i.kind === 'meal'
          ? i.title
          : i.kind === 'grocery'
            ? i.weekKey
            : i.kind === 'journal'
              ? `${i.date} · ${excerpt(i.body, 50) || 'no text'}`
              : i.kind === 'event'
                ? i.title || 'Untitled event'
                : i.kind === 'note'
                  ? i.title || excerpt(htmlToText(i.body), 50) || 'Untitled note'
                  : i.kind === 'garment'
                    ? i.name || 'Untitled piece'
                    : i.kind === 'outfit'
                      ? i.name || pieces(i.garmentIds.length)
                      : i.kind === 'wear'
                        ? `${i.date} · ${pieces(i.garmentIds.length)}`
                        : i.kind === 'snooze'
                          ? `${i.target} put off`
                          : i.kind === 'message'
                            ? i.body || 'A message'
                            : i.kind === 'chat'
                              ? i.text || 'A chat turn'
                              : i.name
  return (
    <Modal onClose={onClose}>
      <ModalHead title="Trash" />
      <div className="modal-body">
        <p className="field-hint">
          Deleted items stay here for {RETENTION_DAYS} days, then disappear for good. Restore puts everything back exactly as it
          was, on every device. Delete forever removes it from this device and marks it deleted for everyone — a stale copy cannot resurrect it.
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
                      <small className="muted">{i.kind === 'wear' && i.planned ? 'Outfit planned' : kindLabel(i.kind)}</small> {label(i)}
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
                  <span className="trash-actions">
                    <button className="btn" onClick={() => onRestore(i.id)}>
                      Restore
                    </button>
                    <ConfirmButton className="btn subtle danger" confirmLabel="Forever? Click again" onConfirm={() => onPurge(i.id)}>
                      Delete forever
                    </ConfirmButton>
                  </span>
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
    </Modal>
  )
}
