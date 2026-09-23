import { useEffect } from 'react'
import { cookTaskUpdates } from '../../kitchen'
import type { Store } from '../../store'

/**
 * Keeps every open cook task in step with its meal and recipes: the steps as
 * its checklist, the ingredients and notes in its description. A recipe edited
 * or filled in with ✨, a side added, a main swapped — the task follows on the
 * next render, and the cook tasks written before they carried their recipe
 * catch up the same way. Ticks, the person's own checklist items and anything
 * written below Kitchen's line stay. Either member's device may do it: both
 * would write the same thing.
 */
export function useCookTaskSync(store: Pick<Store, 'loaded' | 'tasks' | 'meals' | 'recipes' | 'upsert'>): void {
  const { loaded, tasks, meals, recipes, upsert } = store
  useEffect(() => {
    if (!loaded) return
    for (const task of cookTaskUpdates(tasks, meals, recipes)) upsert(task)
  }, [loaded, tasks, meals, recipes, upsert])
}
