import { useEffect, useMemo, useState } from 'react'
import type { useHousehold } from '../../household'
import type { Store } from '../../store'

/** Mine / Everyone: the household's one narrowing, remembered across launches. */
export function useMineOnly({ store, household }: { store: Store; household: ReturnType<typeof useHousehold> }) {
  const [mineOnly, setMineOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem('drafter:mine-only') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('drafter:mine-only', mineOnly ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [mineOnly])
  const inHousehold = !!household.info?.household && (household.info?.members.length ?? 0) > 1

  // Every view reads this, so the household's Mine / Everyone applies app-wide;
  // there is no project filter any more — the person is always on their one
  // home project, and every view gets the full set.
  const filteredTasks = useMemo(() => {
    if (mineOnly && inHousehold && household.myId) return store.tasks.filter(t => (t.assigneeId ? t.assigneeId === household.myId : t.ownerId === household.myId || !t.ownerId))
    return store.tasks
  }, [store.tasks, mineOnly, inHousehold, household.myId])

  return { mineOnly, setMineOnly, inHousehold, filteredTasks }
}
