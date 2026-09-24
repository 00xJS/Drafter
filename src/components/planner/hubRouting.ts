import type { HubRow } from '../../hub'
import type { PlannerCtx } from './ctx'

/**
 * A row tapped in the notification hub: the thing it is about, opened where
 * it lives, as its push or reminder would have opened it — a task in its
 * editor, an event in its own, the week's review, the household's thread, a
 * person's card, a place's row. `before` closes the sheet. A task deleted
 * since, or not on this device yet, says so rather than opening nothing.
 */
export function hubOpener(p: PlannerCtx, before?: () => void): (target: NonNullable<HubRow['target']>) => void {
  const { store, openTask, openReview, openPerson, openPlace, setView, setEventEditor, setChatSide, setPushed, showToast } = p
  return target => {
    before?.()
    if (target.kind === 'task') {
      const t = store.tasks.find(x => x.id === target.id)
      if (t) openTask(t)
      else showToast('That task is not on this device — it may have been deleted, or it will appear after the next sync.')
    } else if (target.kind === 'event') {
      const e = store.events.find(x => x.id === target.id)
      if (e) setEventEditor({ entry: e, startIso: e.start })
      else setView('calendar')
    } else if (target.kind === 'review') openReview()
    else if (target.kind === 'message') {
      // the chat on the household's thread, even if it was left on the assistant's
      setChatSide('household')
      setPushed('chat')
    } else if (target.kind === 'person') openPerson(target.id)
    else if (target.kind === 'place') openPlace(target.id)
  }
}
