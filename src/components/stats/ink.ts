import { graphicInk } from '../../contrast'
import type { Theme } from '../../theme'

/**
 * A row's own colour drawn as a mark on a card — a bar, a dot, a year table's
 * heat: moved just far enough to stand out on the theme's card (graphicInk),
 * so a white tee's bar still shows on white; a row with no colour takes the
 * chart's own.
 */
export const markInk = (color: string | undefined, theme: Theme): string => (color ? graphicInk(color, theme) : 'var(--viz-series-1)')
