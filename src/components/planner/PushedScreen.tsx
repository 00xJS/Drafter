import type { ReactNode } from 'react'
import { ErrorBoundary } from '../ErrorBoundary'
import { tipAttrs } from '../notes/tips'

/**
 * The frame around a screen you go into and come back from.
 *
 * Settings and the chat were sheets. Both are places you spend time in, and a
 * sheet is for a glance: it gave each of them two thirds of a screen to
 * scroll inside and left the tab behind it showing above the fold, cut off
 * mid-card. Worse, a sheet has no header of its own to hold anything still —
 * Settings' section buttons floated over the text scrolling past them.
 *
 * So both are screens now, with a header that does hold still, and they leave
 * by the `‹ Back` control Notes' pad and the note pane already use
 * (`.notes-back`, 14-kitchen-today.css, which draws the chevron). Three back
 * controls became five, all one control.
 */
export function PushedScreen({ title, onBack, head, children }: { title: string; onBack(): void; head?: ReactNode; children: ReactNode }) {
  return (
    <div className="pushed-screen">
      <header className="pushed-head">
        <button type="button" className="btn subtle notes-back" {...tipAttrs('Back')} onClick={onBack}>
          Back
        </button>
        <h2 className="view-title">{title}</h2>
        <span className="spacer" />
        {head}
      </header>
      {/* the screen's body in a boundary of its own, under the header: a body
          that fails to draw leaves ‹ Back on screen, and Back leaves it */}
      <ErrorBoundary where={title}>{children}</ErrorBoundary>
    </div>
  )
}
