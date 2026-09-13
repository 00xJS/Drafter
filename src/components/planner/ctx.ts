import type { useHousehold } from '../../household'
import type { Store } from '../../store'
import type { projectById } from '../../taskutils'
import type { Command } from '../Search'
import type { useCalendarSync } from './useCalendarSync'
import type { useFocusActions } from './useFocusActions'
import type { useLifeActions } from './useLifeActions'
import type { useMineOnly } from './useMineOnly'
import type { useNavigation } from './useNavigation'
import type { useOverlays } from './useOverlays'
import type { useOwner } from './useOwner'
import type { useTaskActions } from './useTaskActions'
import type { useToast } from './useToast'

/**
 * Everything the top bar, the five screens and the overlays can reach: what
 * the planner hooks return, plus the store, the household, the project lookup
 * and the palette's commands. Planner rebuilds it every render and hands it
 * down as one `p` prop. There is no context, so a screen re-renders exactly
 * when Planner does, as it did when all of this was one component.
 */
export type PlannerCtx = {
  store: Store
  household: ReturnType<typeof useHousehold>
  projectMap: ReturnType<typeof projectById>
  paletteCommands: Command[]
} & ReturnType<typeof useMineOnly> &
  ReturnType<typeof useNavigation> &
  ReturnType<typeof useToast> &
  ReturnType<typeof useCalendarSync> &
  ReturnType<typeof useOverlays> &
  ReturnType<typeof useOwner> &
  ReturnType<typeof useLifeActions> &
  ReturnType<typeof useTaskActions> &
  ReturnType<typeof useFocusActions>
