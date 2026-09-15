import type { ReactNode } from 'react'
import { DAY_WINDOWS, type DayWindow } from '../../stats'

/**
 * A Stats card: a title, the line under it, and what sits at the right of its
 * head — a switch or a stepper — over whatever the card holds.
 */
export function ChartCard({ title, sub, aside, className, children }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <section className={className ? `chart-card ${className}` : 'chart-card'}>
      <header className="chart-head">
        <div>
          <h3>{title}</h3>
          {sub !== undefined && <p className="chart-sub">{sub}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  )
}

/**
 * ‹ label ›: a month or a year stepped back and forth at a card's head. `unit`
 * names the arrows for a screen reader ("Previous year"), and `canNext` false
 * stops › at the present, so no month or year still to come is offered.
 */
export function Stepper({ label, unit, onStep, canNext = true }: { label: string; unit: string; onStep(delta: -1 | 1): void; canNext?: boolean }) {
  return (
    <span className="segmented">
      <button type="button" className="seg" aria-label={`Previous ${unit}`} onClick={() => onStep(-1)}>
        ‹
      </button>
      <button type="button" className="seg on">
        {label}
      </button>
      <button type="button" className="seg" aria-label={`Next ${unit}`} disabled={!canNext} onClick={() => onStep(1)}>
        ›
      </button>
    </span>
  )
}

/** The 30 days · 12 months · All switch a ranked chart counts by (DAY_WINDOWS). */
export function WindowSwitch({ value, onChange, windows = DAY_WINDOWS }: { value: DayWindow; onChange(window: DayWindow): void; windows?: readonly { key: DayWindow; label: string }[] }) {
  return (
    <span className="segmented">
      {windows.map(s => (
        <button key={String(s.key)} type="button" aria-pressed={value === s.key} className={value === s.key ? 'seg on' : 'seg'} onClick={() => onChange(s.key)}>
          {s.label}
        </button>
      ))}
    </span>
  )
}
