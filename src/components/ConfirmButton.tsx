import { useEffect, useRef, useState } from 'react'

interface Props {
  onConfirm(): void
  /** Idle label. */
  children: React.ReactNode
  /** Label while armed (second click confirms). */
  confirmLabel?: string
  className?: string
  title?: string
  /**
   * The button's accessible name, for when its text alone does not say what it
   * acts on (a bare ✕). While armed the confirm step follows it ("Delete Milk:
   * Click again to delete"), or a screen reader would never hear that step.
   */
  ariaLabel?: string
  /**
   * What it does, in words: the quick tooltip on a notes page (data-tip, see
   * NoteTips), and the title and accessible name when those are not given.
   */
  tip?: string
  stopPropagation?: boolean
}

/**
 * Two-step destructive button: the first click arms it, a second click within
 * 4 seconds confirms. Clicking elsewhere, pressing a key or waiting disarms it.
 */
export function ConfirmButton({ onConfirm, children, confirmLabel = 'Click again to delete', className = 'btn danger', title, ariaLabel, tip, stopPropagation }: Props) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const name = ariaLabel ?? tip

  useEffect(() => {
    if (!armed) return
    timer.current = window.setTimeout(() => setArmed(false), 4000)
    const disarm = () => setArmed(false)
    window.addEventListener('keydown', disarm)
    return () => {
      window.clearTimeout(timer.current)
      window.removeEventListener('keydown', disarm)
    }
  }, [armed])

  return (
    <button
      type="button"
      className={armed ? `${className} armed` : className}
      title={title ?? tip}
      aria-label={name && armed ? `${name}: ${confirmLabel}` : name}
      data-tip={tip}
      onBlur={() => setArmed(false)}
      onClick={e => {
        if (stopPropagation) e.stopPropagation()
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
