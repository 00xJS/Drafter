import type { AskDoc } from '../../ask'
import type { PlannerCtx } from './ctx'

/**
 * A source or a citation tapped in Ask Drafter, or under an answer in Home →
 * Chat: the record, opened where it lives. A subscribed calendar's event has
 * no editor of its own, so it opens the Calendar.
 *
 * Built from the shell rather than held by either surface, because both show
 * the same chips over the same records and a citation must go to the same
 * place from each (v3.26). `before` is what the caller does first — the sheet
 * closes itself; the chat page stays where it is.
 */
export function askDocOpener(p: PlannerCtx, before?: () => void): (doc: AskDoc) => void {
  const { store, openTask, openProject, openPlace, openJournal, openPerson, setKitchenRecipe, openKitchen, setView, openWardrobe, setEventEditor } = p
  return doc => {
    before?.()
    if (doc.kind === 'task' || doc.kind === 'bill') {
      const t = store.tasks.find(x => x.id === doc.id)
      if (t) openTask(t)
    } else if (doc.kind === 'project') {
      const found = store.projects.find(x => x.id === doc.id)
      if (found) openProject(found)
    } else if (doc.kind === 'place') openPlace(doc.id)
    else if (doc.kind === 'journal') openJournal(doc.date)
    else if (doc.kind === 'person') openPerson(doc.id)
    else if (doc.kind === 'recipe') {
      const r = store.recipes.find(x => x.id === doc.id)
      if (r) setKitchenRecipe(r)
      openKitchen()
    } else if (doc.kind === 'meal') openKitchen()
    // a piece opens its sheet over Clothes; a look, the composer on its day
    else if (doc.kind === 'garment') openWardrobe({ tab: 'clothes', garmentId: doc.id })
    else if (doc.kind === 'wear') openWardrobe({ date: doc.date })
    else if (doc.kind === 'event') {
      const e = doc.feed ? undefined : store.events.find(x => x.id === doc.id)
      if (e) setEventEditor({ entry: e, startIso: e.start })
      else setView('calendar')
    }
  }
}
