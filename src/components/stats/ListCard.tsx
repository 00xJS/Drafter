import type { ReactNode } from 'react'
import { ChartCard } from './ChartCard'

/**
 * A titled list in a card — what has rested longest, what was never used —
 * each item drawn by `row` (a ListRow, most often), or `empty` in words when
 * there is none.
 */
export function ListCard<T>({
  title,
  sub,
  items,
  empty,
  row,
  className,
  prefix = 'stats',
}: {
  title: ReactNode
  sub?: ReactNode
  items: readonly T[]
  empty?: ReactNode
  /** An item's row, with its own key. */
  row(item: T): ReactNode
  className?: string
  /** The class prefix its styles are keyed by: the kit's own, or 'wardrobe' for the wardrobe's, which draw alike. */
  prefix?: string
}) {
  return (
    <ChartCard title={title} sub={sub} className={className}>
      {items.length === 0 ? empty !== undefined && <p className="empty">{empty}</p> : <ul className={`${prefix}-list`}>{items.map(item => row(item))}</ul>}
    </ChartCard>
  )
}

/**
 * A list card's row: a picture (a thumbnail, an avatar), a name and the line
 * under it, as a button when `onOpen` is given, and an `action` at its end —
 * a Retire, a Plan, a figure.
 */
export function ListRow({
  picture,
  name,
  line,
  onOpen,
  action,
  prefix = 'stats',
}: {
  picture?: ReactNode
  name: ReactNode
  line?: ReactNode
  onOpen?(): void
  action?: ReactNode
  /** The class prefix its styles are keyed by: the kit's own, or 'wardrobe' for the wardrobe's, which draw alike. */
  prefix?: string
}) {
  const face = (
    <>
      {picture}
      <span>
        <span className={`${prefix}-list-name`}>{name}</span>
        {line !== undefined && <small className="muted">{line}</small>}
      </span>
    </>
  )
  return (
    <li className={`${prefix}-list-row`}>
      {onOpen ? (
        <button type="button" className={`${prefix}-list-piece`} onClick={onOpen}>
          {face}
        </button>
      ) : (
        <span className={`${prefix}-list-piece`}>{face}</span>
      )}
      {action}
    </li>
  )
}
