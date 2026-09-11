import type { CSSProperties } from 'react'

/**
 * One inline stroke-icon set for the app chrome, drawn to a 24×24 box in
 * `currentColor` so an icon takes the colour of the text around it. These
 * replace the emoji that used to stand in for icons in the tab bars, the More
 * sheet and the header — emoji render differently on every OS and read as
 * informal; a consistent line set reads as a product. Keep them geometric and
 * light (stroke ~1.75); heavier marks pass a thicker `strokeWidth`.
 */
export type IconName =
  | 'today'
  | 'tasks'
  | 'board'
  | 'calendar'
  | 'notes'
  | 'people'
  | 'kitchen'
  | 'bills'
  | 'review'
  | 'journal'
  | 'more'
  | 'search'
  | 'settings'
  | 'plus'
  | 'brand'

const PATHS: Record<IconName, JSX.Element> = {
  today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="16.5" rx="3" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </>
  ),
  more: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2.2" />
    </>
  ),
  kitchen: (
    <>
      <path d="M7 3v4.2a1.6 1.6 0 0 0 3.2 0V3M8.6 7.8V21" />
      <path d="M16.6 3c-1.3 1.6-1.7 4.1-1.7 6.4 0 1.7.8 2.6 1.7 2.6M16.6 3v18" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.3" />
      <path d="M3.4 20.2a5.6 5.6 0 0 1 11.2 0" />
      <path d="M15.8 5.1a3.3 3.3 0 0 1 0 6M17.4 20.2a5.6 5.6 0 0 0-2.1-4.4" />
    </>
  ),
  tasks: (
    <>
      <path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10" />
      <path d="M3.6 5.9l1.3 1.3 2.4-2.6M3.6 11.4l1.3 1.3 2.4-2.6M3.6 16.9l1.3 1.3 2.4-2.6" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16M15 4v16" />
    </>
  ),
  notes: (
    <>
      <path d="M4 20.2h3.5L19.3 8.4a2.2 2.2 0 0 0-3.1-3.1L4.4 17.1z" />
      <path d="M14.2 6.4l3.1 3.1" />
    </>
  ),
  bills: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="3" />
      <path d="M2.5 9.6h19M6 15h4.5" />
    </>
  ),
  review: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M7 20.5v-6.5M12 20.5v-11M17 20.5v-8" />
    </>
  ),
  journal: (
    <>
      <path d="M5 4.6A2.6 2.6 0 0 1 7.6 2H19.5v15.4H7.6A2.6 2.6 0 0 0 5 20z" />
      <path d="M5 20a2.6 2.6 0 0 1 2.6-2.6H19.5" />
      <path d="M9 6.6h6.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.6" />
      <path d="M20.5 20.5l-5.1-5.1" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  brand: <path d="M7 4.6h4.4a7.4 7.4 0 0 1 0 14.8H7z" />,
}

interface IconProps {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
  /** brand mark wants a filled glyph rather than a stroked outline */
  filled?: boolean
}

export function Icon({ name, size, strokeWidth = 1.75, className, style, filled = false }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      style={style}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
