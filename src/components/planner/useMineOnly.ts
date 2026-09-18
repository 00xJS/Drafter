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

  // Mine / Everyone sits above the Notes segment too, and used to do nothing
  // there — "I am not sure the mine vs everyone's section on the notes works".
  // Now that a note is private until its owner shares it, the peers' notes in
  // this list are exactly the ones they chose to share, and Mine hides them.
  const filteredNotes = useMemo(() => {
    if (mineOnly && inHousehold && household.myId) return store.notes.filter(n => !n.ownerId || n.ownerId === household.myId)
    return store.notes
  }, [store.notes, mineOnly, inHousehold, household.myId])

  return { mineOnly, setMineOnly, inHousehold, filteredTasks, filteredNotes }
}
