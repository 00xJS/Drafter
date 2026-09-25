import { useState, type MouseEvent, type ReactNode } from 'react'

/**
 * Reading a chart's marks by touch.
 *
 * On a desktop a mark is read by pointing at it: its `<title>`, or its title
 * attribute. A phone has no pointer to rest on anything, and those words were
 * in no other place, so a chart there showed its shape and none of its
 * figures. A tap on a mark says it in a line under the chart instead, as the
 * Journal's mood chart says a day under a scrub.
 *
 * Each mark carries its words as `data-read`; the chart takes `onClick`, and
 * draws `line` under itself. The line is always there, with a hint in it until
 * the first tap on a touch screen (05-stats-charts.css), so the first tap does
 * not push the chart out from under the finger that made it.
 */
export function useReadout(hint: string): { onClick(e: MouseEvent): void; line: ReactNode } {
  const [said, setSaid] = useState('')
  return {
    onClick: e => {
      const mark = e.target instanceof Element ? e.target.closest('[data-read]') : null
      const words = mark?.getAttribute('data-read')
      if (words) setSaid(words)
    },
    line: (
      <p className="chart-readout" aria-live="polite">
        {said || <span className="chart-readout-hint">{hint}</span>}
      </p>
    ),
  }
}

/** A day key as a chart's readout says it: "Tue, Sep 22". */
export function readDay(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : key
}
