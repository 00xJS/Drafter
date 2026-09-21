import type { ReactNode } from 'react'
import { INNER_VIEWS, type InnerView } from './routes'

/**
 * A segment's own List · Stats: its list, or its figures. Shaped as the
 * wardrobe's Outfit · Clothes · Stats — small buttons, not the tab-level
 * track the native shell draws for People · Places — and remembered per
 * segment by the caller (setInnerView), the way the segments are.
 * `action` sits on the right of that same row (People's and Places' add).
 */
export function ListStatsSwitch({ label, value, onChange, action }: { label: string; value: InnerView; onChange(view: InnerView): void; action?: ReactNode }) {
  return (
    <div className="list-stats-bar">
      <span className="segmented list-stats-seg" role="tablist" aria-label={label}>
        {INNER_VIEWS.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={value === t.key ? 'seg on' : 'seg'} onClick={() => onChange(t.key)}>
            {t.label}
          </button>
        ))}
      </span>
      {action && <span className="list-stats-action">{action}</span>}
    </div>
  )
}
