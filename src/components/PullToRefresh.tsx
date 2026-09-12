import { useEffect, useRef, useState } from 'react'
import { haptic } from '../native'
import { IDLE, PullState, step } from '../pull'
import { Icon } from './Icon'

/**
 * A refresh that has already finished stays visible this long, so a sync that
 * came back in 80ms still reads as "it did something" rather than a flicker
 * the eye cannot place.
 */
const MIN_SPIN_MS = 500

/**
 * A touch that starts on any of these is somebody else's: an open sheet or
 * dialog scrolls on its own, and a field's caret drag must not tug the page.
 * The day sheet lives inside <main>, so Planner cannot pass it in `enabled`;
 * the target check is what covers it.
 */
const OWNED_BY_OTHERS = '.modal-backdrop, [role="dialog"], .cal-sheet-backdrop, input, textarea, select, [contenteditable]'

interface PullToRefreshProps {
  /** false while an editor or sheet owns the screen */
  enabled: boolean
  onRefresh: () => Promise<unknown>
}

/**
 * iOS pull to refresh: drag down from the top of a tab and let go to run the
 * same refresh the app runs when it comes to the foreground. Only the disc
 * moves — the body is the scroller and the top bar is sticky, so translating
 * the content would drag both. Gated on the html.native class rather than
 * isNative() so ?native=1 in a browser previews it (a synthesised touch is
 * enough); haptic() is a no-op there anyway.
 */
export function PullToRefresh({ enabled, onRefresh }: PullToRefreshProps) {
  // main.tsx stamps the class before React renders, so one read is enough
  const [native] = useState(() => document.documentElement.classList.contains('native'))
  const state = useRef<PullState>(IDLE)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const [paint, setPaint] = useState<{ travel: number; armed: boolean; pulling: boolean; refreshing: boolean }>({ travel: 0, armed: false, pulling: false, refreshing: false })

  useEffect(() => {
    if (!enabled || !native) return
    // a refresh that outlives this effect (a sheet opened mid-spin) still
    // paints its own end, so the disc never stays lit after the sync is done
    const show = (s: PullState) => setPaint({ travel: s.travel, armed: s.band === 'armed', pulling: s.phase === 'pulling', refreshing: s.phase === 'refreshing' })

    // touchmove is only ever attached while a pull is live, and non-passive
    // only then: ordinary scrolling, the swipe rows and the board's sideways
    // scroll never pay for a listener that might call preventDefault
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      const r = step(state.current, { type: 'move', x: t.clientX, y: t.clientY })
      if (r.state === state.current) return
      state.current = r.state
      if (r.state.phase === 'idle') {
        // handed off to a sideways gesture or an upward scroll
        document.removeEventListener('touchmove', onMove)
        return
      }
      // the pull owns the touch now: this is what stops WKWebView's own
      // rubber-band from bouncing the whole page under the disc
      e.preventDefault()
      if (r.buzz) void haptic('light')
      show(r.state)
    }
    const stopMoves = () => document.removeEventListener('touchmove', onMove)

    const onStart = (e: TouchEvent) => {
      if (state.current.phase !== 'idle') return
      if (e.touches.length !== 1 || window.scrollY > 0) return
      if (document.documentElement.classList.contains('keyboard-open')) return
      const target = e.target as Element | null
      if (target?.closest?.(OWNED_BY_OTHERS)) return
      const t = e.touches[0]
      state.current = step(state.current, { type: 'start', x: t.clientX, y: t.clientY }).state
      document.addEventListener('touchmove', onMove, { passive: false })
    }

    const finish = async () => {
      const started = Date.now()
      try {
        await onRefreshRef.current()
      } catch {
        /* the sync pill reports its own error; the gesture only reports done */
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, Math.max(0, MIN_SPIN_MS - (Date.now() - started))))
      state.current = step(state.current, { type: 'done' }).state
      show(state.current)
    }

    const onEnd = () => {
      stopMoves()
      const r = step(state.current, { type: 'end' })
      state.current = r.state
      show(r.state)
      if (r.refresh) void finish()
    }
    const onCancel = () => {
      stopMoves()
      state.current = step(state.current, { type: 'cancel' }).state
      show(state.current)
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      stopMoves()
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onCancel)
      // a sheet opening mid-pull takes the gesture away; a refresh in flight
      // finishes on its own and the next mount starts clean
      if (state.current.phase !== 'refreshing') state.current = IDLE
    }
  }, [enabled, native])

  if (!native) return null
  const { travel, armed, pulling, refreshing } = paint
  const cls = 'ptr' + (armed ? ' ptr-armed' : '') + (refreshing ? ' ptr-refreshing' : '')
  return (
    <div
      className={cls}
      // the disc follows the finger from state, not from a transition, so the
      // spring only plays on the way home (and Reduce Motion still gets travel)
      style={{ transform: `translate(-50%, ${travel}px)`, opacity: travel > 0 || refreshing ? 1 : 0, transition: pulling ? 'none' : undefined }}
    >
      <span className="ptr-disc" aria-hidden>
        {/* the arrow turns with the pull; once refreshing the CSS spin owns the transform */}
        <Icon name="refresh" size={18} style={refreshing ? undefined : { transform: `rotate(${travel * 2.5}deg)` }} />
      </span>
      <span className="ptr-live" aria-live="polite">
        {refreshing ? 'Refreshing…' : ''}
      </span>
    </div>
  )
}
