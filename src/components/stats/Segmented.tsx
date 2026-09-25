import { useEffect, useRef, type ReactNode } from 'react'

/**
 * A switch as one track with a thumb that slides between the choices, rather
 * than a row of separate outlined buttons — the shape iOS has used since
 * UISegmentedControl, and the one the app already drew in the shell
 * (19-native-shell.css). This is that control for every platform, with the
 * thumb an element of its own so it can travel: the track sets --seg-n and
 * --seg-i and the thumb reads them, so moving between two choices is one
 * transform rather than a colour appearing somewhere else.
 *
 * The buttons keep the `.seg` markup and roles the rest of the app uses, so a
 * screen reader hears the same control it always did and Reduce Motion (a
 * blanket rule in 01-base.css) simply puts the thumb where it belongs at once.
 *
 * `scroll` is for a track with more choices than fit a phone — the Stats lens
 * had nine, until its areas became chips. Then the segments take their own widths and the track scrolls,
 * keeping the chosen one in view; there is no thumb, because a thumb that has
 * to travel past the edge of its own track is a worse answer than a raised
 * button. Every other track keeps the thumb.
 */
export function Segmented<K extends string>({
  items,
  value,
  onChange,
  label,
  className,
  role = 'tablist',
  scroll = false,
}: {
  items: readonly { key: K; label: ReactNode }[]
  value: K
  onChange(key: K): void
  /** What the control is for, for a screen reader ("Stats view"). */
  label: string
  className?: string
  /** 'tablist' when each choice swaps the panel below; 'group' when it only narrows what is already there. */
  role?: 'tablist' | 'group'
  /** More choices than fit: the segments keep their own widths, the track scrolls, and the chosen one is kept in view. */
  scroll?: boolean
}) {
  const index = Math.max(
    0,
    items.findIndex(i => i.key === value),
  )
  const tab = role === 'tablist'
  // a chosen segment off the end of a scrolling track has to come into view, or
  // the control looks like it did nothing
  const chosen = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (scroll) chosen.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [scroll, value])
  const classes = ['segmented', 'seg-track', scroll ? 'seg-scroll' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <span className={classes} role={role} aria-label={label} style={{ '--seg-n': items.length, '--seg-i': index } as React.CSSProperties}>
      {!scroll && <span className="seg-thumb" aria-hidden />}
      {items.map(item => {
        const on = item.key === value
        return (
          <button
            key={item.key}
            ref={on ? chosen : undefined}
            type="button"
            role={tab ? 'tab' : undefined}
            aria-selected={tab ? on : undefined}
            aria-pressed={tab ? undefined : on}
            className={on ? 'seg on' : 'seg'}
            onClick={() => onChange(item.key)}
          >
            {item.label}
          </button>
        )
      })}
    </span>
  )
}
