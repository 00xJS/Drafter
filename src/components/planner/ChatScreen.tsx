import { Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { noteMessageSent } from '../../activity'
import { messageNoticesShown } from '../../hub'
import { newerStamp, trashedLine } from '../../itemops'
import type { CalendarEntry, Meal, Task } from '../../types'
import type { ChatOpen, ChatShell } from '../Chat'
import { ErrorBoundary } from '../ErrorBoundary'
import { askDocOpener } from './askRouting'
import type { PlannerCtx } from './ctx'
import { PushedScreen } from './PushedScreen'

/** An editor the chat opened on one of the assistant's suggestions, and what to do once it saves. */
type Editing = { kind: 'task'; preset: Partial<Task>; done(t: Task): void } | { kind: 'event'; entry: CalendarEntry; done(e: CalendarEntry): void }

/** An editor's own boundaries, as Overlays gives each of its own: a chunk that fails takes down the editor, not the chat. */
function Layer({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ErrorBoundary where={name}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  )
}

/** Whether the page is in front of anyone: a tab in the background, or the phone's app behind another, is not. */
const pageShown = () => document.visibilityState !== 'hidden'
function onShownChange(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

/**
 * The chat, as a screen you go into.
 *
 * It reads across every tab and the household half carries a badge somebody
 * else fills, so its door stays in the top bar, reachable from wherever you
 * are. What changed is where the door leads: a sheet, which left the tab
 * behind it showing above the fold and gave the thread two thirds of a screen
 * to live in, became a page with a back button.
 *
 * The assistant's suggestions are applied through the shell's own paths — the
 * store, a meal's save that rebuilds its grocery list, an event's mirrors, a
 * status change's GitHub write-back — so a change made from the chat behaves
 * as the same change made anywhere else. Edit opens the app's own task and
 * event editors here, over the chat, and saving one is the apply.
 *
 * A household message sent from here is told to the rest of the household
 * once the server has it (src/activity.ts), and the bell's word of messages
 * this thread has shown is read here too.
 */
export function ChatScreen({ p }: { p: PlannerCtx }) {
  const { Chat, EventEditor, TaskEditor } = p.views
  const { store, upsert, remove, restore, household, allEvents, setPushed, chatSide, setChatSide, chatSeenAt, markChatSeen, showToast } = p
  const [editing, setEditing] = useState<Editing | null>(null)

  // Reading the household thread is reading the hub's word of it: a message
  // notice is marked read once the thread has shown its newest message — on
  // opening the chat, and as messages arrive while it is open. Only while the
  // page is in front of someone: the mark reaches every device of theirs, and
  // a laptop left on the chat in a background tab has shown nobody anything.
  const shown = useSyncExternalStore(onShownChange, pageShown, () => false)
  const shownUpTo = shown && chatSide === 'household' ? chatSeenAt : null
  useEffect(() => {
    const read = messageNoticesShown(store.notices, shownUpTo)
    if (!read.length) return
    const at = new Date().toISOString()
    for (const n of read) upsert({ ...n, readAt: at, updatedAt: newerStamp(n.updatedAt) })
  }, [store.notices, shownUpTo, upsert])
  // a record named in an answer opens where it lives, which means leaving the chat
  const leave = () => setPushed(null)
  const openAskDoc = askDocOpener(p, leave)

  /** An applied card's Open: the record, where it lives. */
  const open = (target: ChatOpen) => {
    if (target.kind === 'task') {
      const t = store.tasks.find(x => x.id === target.id)
      if (t) {
        leave()
        p.openTask(t)
      }
    } else if (target.kind === 'note') {
      leave()
      p.openNote(target.id)
    } else if (target.kind === 'event') {
      const e = store.events.find(x => x.id === target.id)
      if (e) p.setEventEditor({ entry: e, startIso: e.start })
    } else if (target.kind === 'meal') {
      leave()
      p.openKitchenDay(target.day)
    } else {
      leave()
      p.openKitchen('grocery')
    }
  }

  const shell: ChatShell = {
    people: store.people,
    recipes: store.recipes,
    places: store.places,
    tasks: store.tasks,
    meals: store.meals,
    // tombstones too: a slot cleared earlier is built on, so the new meal is stamped newer than it
    mealRows: store.allItems.filter((i): i is Meal => i.kind === 'meal'),
    groceries: store.groceries,
    notes: store.notes,
    events: store.events,
    myId: store.myId,
    inHousehold: p.inHousehold,
    upsert,
    remove,
    setStatus: p.applyStatus,
    pushToProjectBoard: p.pushToProjectBoard,
    saveMeal: p.saveMeal,
    clearMeal: p.clearMeal,
    saveEvents: p.saveEvents,
    removeEvent: id => void p.removeEvent(id),
    createRecipe: p.createRecipeInline,
    createPlace: p.createPlaceInline,
    savePerson: person => upsert(person),
    savePlace: place => upsert(place),
    toast: showToast,
    editTask: (preset, done) => setEditing({ kind: 'task', preset, done }),
    editEvent: (entry, done) => setEditing({ kind: 'event', entry, done }),
    open,
  }

  return (
    <PushedScreen title="Chat" onBack={leave}>
      <Chat
        side={chatSide}
        onSide={setChatSide}
        // opening the household thread is reading it: the badge clears here,
        // not on a timer, so a message arriving while you read never counts
        onSeen={markChatSeen}
        // the household's thread, and yours with the assistant. Two kinds,
        // two threads, and the second is personal at the database (v3.26)
        messages={store.messages}
        turns={store.chat}
        household={household.info}
        myId={household.myId}
        // what the assistant may read: the same list Ask is handed, minus the
        // journal — a chat that remembers what it was told is not where a
        // diary belongs, and Ask's own chip is the place to turn that on
        sources={{
          tasks: store.tasks,
          projects: store.projects,
          people: store.people,
          places: store.places,
          recipes: store.recipes,
          meals: store.meals,
          entries: store.events,
          feedEvents: allEvents,
          journal: [],
          garments: store.garments,
          outfits: store.outfits,
          wears: store.wears,
          myId: store.myId,
        }}
        tz={Intl.DateTimeFormat().resolvedOptions().timeZone}
        onSendMessage={m => {
          upsert(m)
          // told to the rest of the household once the server has it: from
          // here, the device that wrote it, and only with somebody to tell
          if (p.inHousehold) noteMessageSent(m, store.myId)
        }}
        onRemoveMessage={id => {
          remove(id)
          showToast(trashedLine(null, 'Message'), () => restore([id]))
        }}
        onWriteTurn={t => upsert(t)}
        onClearChat={ids => {
          for (const id of ids) remove(id)
          showToast(`Cleared ${ids.length} turn${ids.length === 1 ? '' : 's'}`, () => restore(ids))
        }}
        onOpen={openAskDoc}
        shell={shell}
      />

      {editing?.kind === 'task' && (
        <Layer name="the task editor">
          <TaskEditor
            preset={editing.preset}
            // the suggestion is already read: the editor opens on it as it stands
            capture={false}
            projects={store.projects}
            people={store.people}
            places={store.places}
            onSavePlace={place => upsert(place)}
            onSavePerson={person => upsert(person)}
            members={p.inHousehold ? (household.info?.members ?? []) : []}
            myId={household.myId}
            candidates={store.tasks.filter(t => t.status !== 'canceled')}
            getLatest={id => store.tasks.find(x => x.id === id)}
            onSave={t => {
              upsert(t)
              setEditing(null)
              editing.done(t)
            }}
            onDiscard={() => showToast('Nothing to save — that task was empty.')}
            onCommit={t => upsert(t)}
            // a task not saved yet has nothing to delete
            onDelete={() => setEditing(null)}
            onClose={() => setEditing(null)}
          />
        </Layer>
      )}

      {editing?.kind === 'event' && (
        <Layer name="the event editor">
          <EventEditor
            entry={editing.entry}
            defaultStartIso={editing.entry.allDay ? `${editing.entry.start}T09:00` : editing.entry.start}
            people={store.people}
            onSavePerson={person => upsert(person)}
            onSave={entries => {
              p.saveEvents(entries)
              const first = entries[0]
              setEditing(null)
              if (first) editing.done(first)
            }}
            onClose={() => setEditing(null)}
          />
        </Layer>
      )}
    </PushedScreen>
  )
}
