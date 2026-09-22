import { Chat } from './lazy'
import { askDocOpener } from './askRouting'
import type { PlannerCtx } from './ctx'
import { PushedScreen } from './PushedScreen'

/**
 * The chat, as a screen you go into.
 *
 * It reads across every tab and the household half carries a badge somebody
 * else fills, so its door stays in the top bar, reachable from wherever you
 * are. What changed is where the door leads: a sheet, which left the tab
 * behind it showing above the fold and gave the thread two thirds of a screen
 * to live in, became a page with a back button.
 */
export function ChatScreen({ p }: { p: PlannerCtx }) {
  const { store, household, allEvents, setPushed, chatSide, setChatSide, markChatSeen, showToast } = p
  // a record named in an answer opens where it lives, which means leaving the chat
  const openAskDoc = askDocOpener(p, () => setPushed(null))
  return (
    <PushedScreen title="Chat" onBack={() => setPushed(null)}>
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
        }}
        tz={Intl.DateTimeFormat().resolvedOptions().timeZone}
        onSendMessage={m => store.upsert(m)}
        onRemoveMessage={id => {
          store.remove(id)
          showToast('Message deleted', () => store.restore([id]))
        }}
        onWriteTurn={t => store.upsert(t)}
        onClearChat={ids => {
          for (const id of ids) store.remove(id)
          showToast(`Cleared ${ids.length} turn${ids.length === 1 ? '' : 's'}`, () => store.restore(ids))
        }}
        onOpen={openAskDoc}
      />
    </PushedScreen>
  )
}
