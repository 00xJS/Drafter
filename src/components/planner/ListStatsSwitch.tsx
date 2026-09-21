import type { ReactNode } from 'react'
import { Segmented } from '../stats/Segmented'
import { INNER_VIEWS, type InnerView } from './routes'

/**
 * A segment's own List · Stats: its list, or its figures. Remembered per
 * segment by the caller (setInnerView), the way the segments are, and
 * `action` sits on the right of that same row (People's and Places' add).
 *
 * It was drawn as two small outlined buttons on the theory that a tab-level
 * switch takes the track and a switch inside one does not. On a phone that
 * two-tier idea did not survive contact: the pair sat at the left of the row
 * with a hole between them and the add button, next to a People · Places
 * track directly above that filled its line, and read as two buttons somebody
 * had forgotten to finish rather than as a quieter kind of control. One rule
 * now: a choice between views that exclude each other is a track, at every
 * level — which is also what UISegmentedControl does (v3.28).
 */
export function ListStatsSwitch({ label, value, onChange, action }: { label: string; value: InnerView; onChange(view: InnerView): void; action?: ReactNode }) {
  return (
    <div className="list-stats-bar">
      <Segmented items={INNER_VIEWS} value={value} onChange={onChange} label={label} className="list-stats-seg" />
      {action && <span className="list-stats-action">{action}</span>}
    </div>
  )
}
