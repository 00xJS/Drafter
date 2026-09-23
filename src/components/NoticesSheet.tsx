import { useEffect, useMemo, useState } from 'react'
import { byDay, howLongAgo, hubRows, markHubSeen, readHubSeen, unreadNotice, useFiredReminders, type HubRow, type ReminderSources } from '../hub'
import type { Notice, NoticeType } from '../types'
import { useDayKey } from '../useDayKey'
import { useNow } from '../useNow'
import { Icon, type IconName } from './Icon'
import { Modal, ModalHead } from './Modal'

/** A row's glyph: what kind of news it is. */
const ICONS: Record<NoticeType | 'reminder', IconName> = {
  assigned: 'tasks',
  progress: 'board',
  done: 'checkbox',
  comment: 'chat',
  changed: 'refresh',
  digest: 'today',
  alarm: 'alert',
  reminder: 'bell',
}

interface Props extends ReminderSources {
  notices: Notice[]
  /** Mark one notice read: it syncs to the reader's other devices like any edit. */
  onRead(n: Notice): void
  onReadAll(ns: Notice[]): void
  /** Open what a row is about; the shell closes the sheet first. */
  onOpen(target: NonNullable<HubRow['target']>): void
  onClose(): void
}

/**
 * The notification hub, opened from the bell on Home: what the other member
 * did to a task you share, the morning digest, alarms, and each reminder this
 * device rang in the last week — so one swiped away unread can still be read.
 * Newest first, under Today, Yesterday and then the date.
 *
 * A notice stays unread until it is tapped (or all are marked read); a
 * reminder counts as seen once the hub has been opened after it rang, so
 * opening this marks the hub seen — while the rows keep their dots for this
 * visit, from the time it was opened before.
 */
export function NoticesSheet({ notices, onRead, onReadAll, onOpen, onClose, ...sources }: Props) {
  // what was new when the sheet opened stays marked while it is up
  const [since] = useState(readHubSeen)
  useEffect(() => markHubSeen(Date.now()), [])
  const reminders = useFiredReminders(sources)
  const now = useNow()
  const today = useDayKey()
  const rows = useMemo(() => hubRows(notices, reminders, since), [notices, reminders, since])
  const groups = useMemo(() => byDay(rows, today), [rows, today])
  const unread = notices.filter(unreadNotice)

  const open = (row: HubRow) => {
    if (row.notice && unreadNotice(row.notice)) onRead(row.notice)
    if (row.target) onOpen(row.target)
  }

  return (
    <Modal onClose={onClose} className="modal narrow notices-sheet">
      <ModalHead title="Notifications">
        {unread.length > 0 && (
          <button type="button" className="btn subtle notices-read-all" onClick={() => onReadAll(unread)}>
            Mark all as read
          </button>
        )}
      </ModalHead>
      <div className="modal-body">
        {groups.length === 0 ? (
          <div className="notices-empty">
            <Icon name="bell" size={28} />
            <p>You’re all caught up.</p>
            <p className="field-hint">
              When someone finishes, comments on or changes a task you share, it shows here — with the morning digest, and each reminder this device rings, for a week.
            </p>
          </div>
        ) : (
          groups.map(g => (
            <section key={g.day} className="notices-day" aria-label={g.label}>
              <h3>{g.label}</h3>
              <ul className="notices-list">
                {g.rows.map(row => (
                  <li key={row.key}>
                    <button type="button" className={row.unread ? 'notice-row unread' : 'notice-row'} onClick={() => open(row)}>
                      <span className={`notice-icon is-${row.type}`} aria-hidden>
                        <Icon name={ICONS[row.type]} size={18} />
                      </span>
                      <span className="notice-text">
                        <span className="notice-title">{row.title}</span>
                        {row.lines.map((line, i) => (
                          <span key={i} className="notice-line">
                            {line}
                          </span>
                        ))}
                      </span>
                      <span className="notice-meta">
                        <time dateTime={new Date(row.at).toISOString()}>{howLongAgo(row.at, now)}</time>
                        {row.unread && <span className="notice-dot" role="img" aria-label="Unread" />}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </Modal>
  )
}
