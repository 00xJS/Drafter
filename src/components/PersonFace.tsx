import type { CSSProperties } from 'react'
import { readableInk, type InkGround } from '../contrast'
import type { Theme } from '../theme'
import type { Person } from '../types'

/**
 * A person in a Stats view: their emoji, or their initial, on a tint of their
 * own colour, written in that colour moved just far enough to read on it
 * (readableInk). The tint is laid over the ground it sits on — the card, or
 * with `ground` 'raised' a month's day cell (--surface-2), the ground its ink
 * is worked out for — so the face is opaque, and a pair's second face covers
 * the first's edge rather than showing it through. The name beside it, or the
 * day's label, says who, so a reader skips it. People → Stats and Places →
 * Stats both draw people with it, so a person looks the same in each.
 */
export function PersonFace({ person, theme, className, ground }: { person: Person; theme: Theme; className: string; ground?: InkGround }) {
  const tint = `${person.color}22`
  const style: CSSProperties = {
    background: `linear-gradient(${tint}, ${tint}), ${ground === 'raised' ? 'var(--surface-2)' : 'var(--surface)'}`,
    color: readableInk(person.color, theme, { tint: true, ground }),
  }
  return (
    <span className={`stats-face ${className}`} style={style} aria-hidden="true">
      {person.emoji || person.name.slice(0, 1).toUpperCase()}
    </span>
  )
}
