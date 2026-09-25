import { graphicInk } from '../../contrast'
import type { Theme } from '../../theme'

/**
 * A row's own colour drawn as a mark on a card — a bar, a dot, a year table's
 * heat: moved just far enough to stand out on the theme's card (graphicInk),
 * so a white tee's bar still shows on white. A row with no colour takes its
 * area's (18-stats-lens.css, .ink-*), or the chart's own outside one.
 */
export const markInk = (color: string | undefined, theme: Theme): string => (color ? graphicInk(color, theme) : AREA_INK)

/** The mark an area's charts are drawn in: its own colour inside it, the chart series anywhere else. */
export const AREA_INK = 'var(--area-ink, var(--viz-series-1))'

