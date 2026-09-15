import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Garment } from '../../types'
import { wornShort, type WearIndex } from '../../wardrobe'
import { heldBadge } from './composer'
import { FavouriteMark, GarmentInset, GarmentPhoto, hasBack, mainSide, otherSide } from './GarmentPhoto'

interface Props {
  /** "Tops": the row's heading and its radiogroup's name. */
  label: string
  pieces: Garment[]
  ix: WearIndex
  /** The chosen piece; null is the None card, where there is one. */
  selected: string | null
  onSelect(id: string | null): void
  /** A first None card: outerwear and shoes are optional. */
  none?: boolean
  /** The smaller cards of the optional rows. */
  small?: boolean
  /** The middle card's "i": the piece sheet. */
  onInfo(id: string): void
  onAdd(): void
  addLabel: string
  emptyLabel: string
  /** Close an optional row. */
  onHide?(): void
}

/** How still the row must be before the middle card counts as chosen, where the browser has no scrollend. */
const SETTLE_MS = 120

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * One swipeable row of the composer. The cards snap to the middle, and the
 * card in the middle is the one chosen, read once the scroll settles —
 * scrollend where the browser has it, else a moment after the last scroll
 * event; never on an animation frame, which a hidden page never draws. A tap
 * on a side card brings it to the middle; the middle card's "i" opens the
 * piece, so a stray tap never leaves the row. It is a radiogroup: the arrow
 * keys, Home and End choose too, and ‹ › show at the ends for a mouse. No
 * haptic on a snap.
 *
 * A piece with a back photo shows its other side in its photo's corner: a
 * button beside the card, not in it (a radio's contents are not a screen
 * reader's to reach), that swaps the card's two sides for this visit and
 * saves nothing. A tap on it flips; a swipe from it still scrolls the row.
 */
export function SnapRow({ label, pieces, ix, selected, onSelect, none, small, onInfo, onAdd, addLabel, emptyLabel, onHide }: Props) {
  const row = useRef<HTMLDivElement>(null)
  const cards: (Garment | null)[] = none ? [null, ...pieces] : pieces
  const at = Math.max(0, cards.findIndex(g => (g?.id ?? null) === selected))
  const keyAt = (i: number) => cards[i]?.id ?? null
  /** The card a settle just chose: the row already rests there, so it is not scrolled again. */
  const settledOn = useRef<string | null | undefined>(undefined)
  /** After the first draw the row glides to a new choice; the first one is placed at once. */
  const drawn = useRef(false)
  /** The keys moved the choice, so focus follows it (a roving tabindex). */
  const keyed = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  /** The pieces shown by their other side for this visit. */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set())
  const flip = (id: string) =>
    setFlipped(was => {
      const next = new Set(was)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const cells = () => Array.from(row.current?.querySelectorAll<HTMLElement>(':scope > .snap-cell') ?? [])

  useLayoutEffect(() => {
    const chosen = keyAt(at)
    const smooth = drawn.current
    drawn.current = true
    if (settledOn.current === chosen) {
      settledOn.current = undefined
      return
    }
    const el = row.current
    const cell = cells()[at]
    if (!el || !cell) return
    el.scrollTo({ left: cell.offsetLeft + cell.offsetWidth / 2 - el.clientWidth / 2, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, cards.length])

  useEffect(() => {
    if (!keyed.current) return
    keyed.current = false
    cells()[at]?.querySelector<HTMLElement>('[role="radio"]')?.focus({ preventScroll: true })
  }, [at])

  /** The card nearest the middle of the row is the one chosen. */
  const settle = () => {
    window.clearTimeout(timer.current)
    const el = row.current
    if (!el) return
    const middle = el.scrollLeft + el.clientWidth / 2
    let nearest = -1
    let gap = Infinity
    cells().forEach((cell, i) => {
      const d = Math.abs(cell.offsetLeft + cell.offsetWidth / 2 - middle)
      if (d < gap) {
        gap = d
        nearest = i
      }
    })
    if (nearest < 0 || keyAt(nearest) === keyAt(at)) return
    settledOn.current = keyAt(nearest)
    onSelect(keyAt(nearest))
  }
  const settleNow = useRef(settle)
  settleNow.current = settle

  // the row is drawn only while it has cards, so listen again when it appears
  const hasRow = cards.length > 0
  useEffect(() => {
    const el = row.current
    if (!el || !('onscrollend' in el)) return
    const onEnd = () => settleNow.current()
    el.addEventListener('scrollend', onEnd)
    return () => el.removeEventListener('scrollend', onEnd)
  }, [hasRow])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const choose = (i: number) => {
    if (i >= 0 && i < cards.length && i !== at) onSelect(keyAt(i))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = cards.length - 1
    const to = e.key === 'ArrowRight' ? Math.min(last, at + 1) : e.key === 'ArrowLeft' ? Math.max(0, at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null
    if (to === null) return
    e.preventDefault()
    keyed.current = to !== at
    choose(to)
  }

  return (
    <div className={small ? 'snap small' : 'snap'}>
      <div className="snap-head">
        <span className="snap-label">{label}</span>
        {onHide && (
          <button type="button" className="btn subtle snap-hide" onClick={onHide}>
            Hide
          </button>
        )}
      </div>
      {cards.length === 0 ? (
        <button type="button" className="snap-empty" onClick={onAdd}>
          {emptyLabel}
        </button>
      ) : (
        <div className="snap-wrap">
          <button type="button" className="snap-step prev" tabIndex={-1} aria-label={`Previous in ${label}`} disabled={at === 0} onClick={() => choose(at - 1)}>
            ‹
          </button>
          <div
            ref={row}
            className="snap-row"
            role="radiogroup"
            aria-label={label}
            onKeyDown={onKeyDown}
            onScroll={() => {
              window.clearTimeout(timer.current)
              timer.current = window.setTimeout(() => settleNow.current(), SETTLE_MS)
            }}
          >
            {cards.map((g, i) => {
              const on = i === at
              const shown = g ? (flipped.has(g.id) && hasBack(g) ? otherSide(mainSide(g)) : mainSide(g)) : 'front'
              const held = g && heldBadge(g)
              return (
                <div key={g?.id ?? 'none'} className={on ? 'snap-cell on' : 'snap-cell side'}>
                  <div role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className="snap-card" onClick={() => choose(i)}>
                    {g ? (
                      <>
                        {g.favourite && <FavouriteMark />}
                        <GarmentPhoto key={shown} garment={g} side={shown} className="flippable" />
                        <span className="snap-name">{g.name}</span>
                        <span className="snap-line">
                          {held ? (
                            <span className="badge snap-held">{held}</span>
                          ) : ix.days.has(g.id) ? (
                            <span className="snap-worn">{wornShort(ix, g.id)}</span>
                          ) : (
                            <span className="badge snap-new">New</span>
                          )}
                        </span>
                      </>
                    ) : (
                      <span className="snap-none">None</span>
                    )}
                  </div>
                  {g && hasBack(g) && <GarmentInset garment={g} side={otherSide(shown)} className="snap-flip" tabIndex={on ? 0 : -1} onFlip={() => flip(g.id)} />}
                  {/* a piece in Trash, held for the day it was worn, has no sheet to open here */}
                  {on && g && !g.deletedAt && (
                    <button type="button" className="snap-info" aria-label={`About ${g.name}`} onClick={() => onInfo(g.id)}>
                      <span aria-hidden="true">i</span>
                    </button>
                  )}
                </div>
              )
            })}
            <button type="button" className="snap-add" onClick={onAdd}>
              {addLabel}
            </button>
          </div>
          <button type="button" className="snap-step next" tabIndex={-1} aria-label={`Next in ${label}`} disabled={at === cards.length - 1} onClick={() => choose(at + 1)}>
            ›
          </button>
        </div>
      )}
    </div>
  )
}
