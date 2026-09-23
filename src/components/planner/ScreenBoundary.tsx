import type { ReactNode } from 'react'
import { ErrorBoundary } from '../ErrorBoundary'
import { VIEW_LABELS, type View } from './routes'
import type { Pushed } from './useOverlays'

const PUSHED_LABELS: Record<Pushed, string> = { settings: 'Settings', chat: 'Chat', admin: 'Admin' }

/**
 * The boundary around the screen on show: the tab's, or the pushed screen's
 * over it. It is named, and cleared, by whichever is up. Named by the tab
 * alone, a crash in Settings was reported as the tab under it, and going
 * back to that same tab left the message up.
 */
export function ScreenBoundary({ view, pushed, children }: { view: View; pushed: Pushed | null; children: ReactNode }) {
  return (
    <ErrorBoundary where={pushed ? PUSHED_LABELS[pushed] : VIEW_LABELS[view]} resetKey={pushed ?? view}>
      {children}
    </ErrorBoundary>
  )
}
