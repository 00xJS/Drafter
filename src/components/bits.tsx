import { Priority, PRIORITY_META, Project, Task } from '../types'
import { dueLabel, dueTone } from '../taskutils'

export function ProjectChip({ project, compact }: { project: Project; compact?: boolean }) {
  return (
    <span className="pchip static" title={project.name}>
      <span className="pdot" style={{ background: project.color }} />
      {project.emoji && <span className="pchip-emoji">{project.emoji}</span>}
      {!compact && <span className="pchip-name">{project.name}</span>}
    </span>
  )
}

export function PriorityMark({ priority, withLabel }: { priority: Priority; withLabel?: boolean }) {
  if (priority === 'normal' && !withLabel) return null
  const meta = PRIORITY_META[priority]
  return (
    <span className={`prio prio-${priority}`} style={{ color: meta.color }} title={`${meta.label} priority`}>
      {meta.glyph}
      {withLabel && ` ${meta.label}`}
    </span>
  )
}

export function DueBadge({ task }: { task: Task }) {
  if (!task.dueAt) return null
  const tone = dueTone(task)
  const label = dueLabel(task)
  return (
    <span className={`due due-${tone}`} title={label}>
      {label}
    </span>
  )
}

export function ProgressBar({ pct, color }: { pct: number; color?: string }) {
  return (
    <span className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="progress-fill" style={{ width: `${pct}%`, background: color }} />
    </span>
  )
}

/**
 * A counter. Pass `onJump` and it becomes a real button that takes you to
 * whatever it is counting. Omit the prop entirely and it is an inert div,
 * because a tile that never scrolls anywhere must not look or feel pressable —
 * that is every tile on Review and in the journal's stats.
 *
 * `null` is the third state, and the reason the prop is nullable: Today's KPI
 * tiles gain and lose their target as tasks are completed, deferred or synced
 * in, and swapping the ELEMENT under a focused tile drops a keyboard user to
 * the top of the document mid-task. So those stay one button whose target may
 * be missing, dressed and announced as unavailable while it is.
 */
export function StatTile({
  label,
  value,
  sub,
  warn,
  className,
  onJump,
}: {
  label: string
  value: string
  sub?: string
  warn?: boolean
  className?: string
  onJump?: (() => void) | null
}) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className={warn ? 'stat-value stat-warn' : 'stat-value'}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </>
  )
  const cls = `stat-tile${className ? ` ${className}` : ''}`
  if (onJump === undefined) return <div className={cls}>{body}</div>
  return (
    <button
      type="button"
      className={`${cls} stat-jump`}
      onClick={onJump ?? undefined}
      // not `disabled`: disabling a focused button is itself what moves focus
      // to <body>, which is the thing this is here to avoid
      aria-disabled={onJump ? undefined : true}
      title={onJump ? `Go to ${label}` : undefined}
    >
      {body}
    </button>
  )
}
