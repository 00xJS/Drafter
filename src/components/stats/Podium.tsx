import type { ReactNode } from 'react'
import { countOf } from '../../people'
import type { Ranked } from './RankedBars'

const PLACES = ['First', 'Second', 'Third']

/**
 * The top three on a podium: first in the middle and raised highest, second
 * to its left, third to its right — the list reads first to third, and only
 * the drawing moves them. A place nobody has reached yet is an empty step,
 * hidden from a screen reader, so first stays in the middle with one or two.
 * `picture` draws each one's thumbnail or avatar, `note` follows its count
 * (" · Retired"), and with `onOpen` each is a button that opens it.
 */
export function Podium<R extends Ranked>({
  top,
  noun = 'day',
  picture,
  note,
  onOpen,
}: {
  /** Most first; only the first three stand on it. */
  top: readonly R[]
  noun?: string
  picture(row: R): ReactNode
  note?(row: R): string
  onOpen?(row: R): void
}) {
  const three = top.slice(0, PLACES.length)
  return (
    <ol className="podium">
      {three.map((r, i) => {
        const face = (
          <>
            {picture(r)}
            <span className="podium-name">{r.name}</span>
            <span className="podium-count">
              {countOf(r.count, noun)}
              {note?.(r) ?? ''}
            </span>
          </>
        )
        return (
          <li key={r.key} className={`podium-place rank-${i + 1}`}>
            {onOpen ? (
              <button type="button" className="podium-piece" aria-label={`${PLACES[i]}: ${r.name}, ${countOf(r.count, noun)}`} onClick={() => onOpen(r)}>
                {face}
              </button>
            ) : (
              <span className="podium-piece">{face}</span>
            )}
            <span className="podium-step" aria-hidden="true">
              {i + 1}
            </span>
          </li>
        )
      })}
      {PLACES.slice(three.length).map((place, j) => (
        <li key={place} className={`podium-place rank-${three.length + j + 1} vacant`} aria-hidden="true">
          <span className="podium-step" />
        </li>
      ))}
    </ol>
  )
}
