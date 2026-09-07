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
  return <span className={`due due-${tone}`}>{dueLabel(task)}</span>
}

export function ProgressBar({ pct, color }: { pct: number; color?: string }) {
  return (
    <span className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="progress-fill" style={{ width: `${pct}%`, background: color }} />
    </span>
  )
}

export function StatTile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className={warn ? 'stat-value stat-warn' : 'stat-value'}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
