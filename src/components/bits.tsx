import { Priority, PRIORITY_META, Project, Task } from '../types'
import { dueLabel, dueTone } from '../taskutils'
import { graphicInk } from '../contrast'
import { useTheme } from '../theme'

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

/**
 * Who can see this record, said on the row itself.
 *
 * Both states are marked, on tasks and on notes alike: "I want to see which
 * tasks are shared vs which are private with a simple glance." Marking only
 * the exception is quieter and was what the notes list did, but it cannot be
 * glanced at — an unmarked row reads as "private" and as "nothing loaded yet"
 * equally well, and the two kinds default opposite ways, so the same blank row
 * would mean different things in two lists.
 *
 * `by` names the housemate whose record it is; without one the mark just says
 * it is shared. Nothing is drawn outside a household, where there is nobody to
 * share with and the answer is always the same.
 */
export function ShareMark({ shared, by, kind }: { shared: boolean; by?: string | null; kind: 'task' | 'note' }) {
  const thing = kind === 'task' ? 'task' : 'note'
  // Whose it is, said the way each kind means it. A note in your list is one
  // its author CHOSE to share; a task of theirs is simply the household's,
  // which they never had to decide — so "Maria shared this task with you"
  // would credit a decision nobody made.
  const whose = by ? (kind === 'task' ? `${by}’s task — everyone in your household can see it` : `${by} shared this note with you`) : `Everyone in your household can see this ${thing}`
  return shared ? (
    <span className="share-mark is-shared" title={whose}>
      <span aria-hidden="true">👥</span> {by ?? 'Shared'}
    </span>
  ) : (
    <span className="share-mark is-private" title={`Private: only you can see this ${thing}`}>
      <span aria-hidden="true">🔒</span> Private
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

/**
 * A counter (a button when it has somewhere to jump). It lives with the Stats
 * kit now (components/stats) and is re-exported here, straight from its own
 * module, so Today, Review and the journal import it as they always have and
 * the rest of the kit stays out of the first load.
 */
export { StatTile } from './stats/StatTile'

// People's, Places' and the wardrobe's shared figures: they live here, not in
// People.tsx, so neither the Places chunk nor the wardrobe's has to pull in People.

export function Bars({ weekly, color, title = 'Visits per week, last 12 weeks' }: { weekly: number[]; color: string; title?: string }) {
  const max = Math.max(1, ...weekly)
  const theme = useTheme()
  // drawn in an open row (--surface-2): the colour moves only as far as a bar needs to stand out there
  const fill = graphicInk(color, theme, { ground: 'raised' })
  return (
    <span className="person-bars" title={title}>
      {weekly.map((n, i) => (
        <span key={i} className={n === 0 ? 'person-bar zero' : 'person-bar'} style={{ height: `${n === 0 ? 8 : 20 + (n / max) * 80}%`, background: n === 0 ? undefined : fill }} />
      ))}
    </span>
  )
}

/** A year table's trend: more lately, drifting, or steady. The Stats kit's own, re-exported for People's and Places' tables. */
export { TrendBadge } from './stats/TrendBadge'
