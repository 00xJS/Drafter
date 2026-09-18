import type { useHousehold } from '../../household'
import type { Store } from '../../store'
import type { projectById } from '../../taskutils'
import type { Command } from '../Search'
import type { useCalendarSync } from './useCalendarSync'
import type { useListFilters } from './useListFilters'
import type { useFocusActions } from './useFocusActions'
import type { useLifeActions } from './useLifeActions'
import type { useNavigation } from './useNavigation'
import type { useOverlays } from './useOverlays'
import type { useOwner } from './useOwner'
import type { useSyncAlarm } from './useSyncAlarm'
import type { useTaskActions } from './useTaskActions'
import type { useToast } from './useToast'

/**
 * Everything the top bar, the six screens and the overlays can reach: what
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
  /**
   * More than one account shares this planner. It decides whether a record
   * says who can see it — alone there is nobody to share with, so every mark
   * and every control would say the same thing.
   *
   * There is no Mine / Everyone here any more. Whose job a task is (its
   * assignee) and who can see it (v3.19's `shared`) are different questions,
   * and the switch answered the first while looking like it answered the
   * second: "I think the last session had built it wrong". Sharing is now the
   * one control, on the record, where it can be seen and changed.
   */
  inHousehold: boolean
} & ReturnType<typeof useNavigation> &
  ReturnType<typeof useListFilters> &
  ReturnType<typeof useToast> &
  ReturnType<typeof useCalendarSync> &
  ReturnType<typeof useOverlays> &
  ReturnType<typeof useOwner> &
  ReturnType<typeof useSyncAlarm> &
  ReturnType<typeof useLifeActions> &
  ReturnType<typeof useTaskActions> &
  ReturnType<typeof useFocusActions>
