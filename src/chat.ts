import { ChatTurn, MESSAGE_MAX, Message } from './types'
import { uid } from './utils'

// The two chats (v3.26), and why they are two.
//
// One is the household's: you and the people you live with, saying things to
// each other about the week. The other is the assistant's: "tell me about my
// week", "anything due for me tomorrow". The owner asked for both and asked
// for them apart — "so our household chat is not being overtaken by the AI
// chat" — so they are different record kinds, different threads, and nothing
// written in one ever appears in the other. The assistant's side is personal
// at the database (shared/kinds.mjs), which is what makes that true rather
// than merely tidy.
//
// Both are one row per line, never edited after it is written. A thread kept
// as a growing array on one row would be last-write-wins, and two people
// typing in the same minute would lose whichever landed first.

/** How many turns of the conversation the assistant is reminded of. Enough for "and what about Friday?". */
export const CHAT_CONTEXT_TURNS = 8
/** The newest messages a thread draws before "Show older". */
export const CHAT_PAGE = 60

/**
 * An id that sorts by when it was written and cannot collide: the instant,
 * then randomness. Two devices offline in the same millisecond still write two
 * rows, and a list sorted on the id alone is in the right order without
 * reading a clock out of the body.
 */
export const threadId = (kind: 'message' | 'chat', at = new Date()): string => `${kind}~${at.toISOString()}~${uid().slice(0, 10)}`

/** What "Send" writes. Trimmed and capped here, so no caller has to remember to. */
export function newMessage(body: string, about?: Message['about'], at = new Date()): Message | null {
  const text = body.trim().slice(0, MESSAGE_MAX)
  if (!text) return null
  const stamp = at.toISOString()
  return { kind: 'message', id: threadId('message', at), body: text, about, createdAt: stamp, updatedAt: stamp }
}

/** One turn of the assistant conversation, yours or its. */
export function newTurn(role: ChatTurn['role'], text: string, cites?: string[], at = new Date()): ChatTurn | null {
  const said = text.trim().slice(0, MESSAGE_MAX)
  if (!said) return null
  const stamp = at.toISOString()
  return { kind: 'chat', id: threadId('chat', at), role, text: said, cites: cites?.length ? cites : undefined, createdAt: stamp, updatedAt: stamp }
}

/** A row in a thread: a day's heading, or something somebody said. */
export type ThreadRow<T> = { day: string } | { item: T; firstOfRun: boolean }

/**
 * A thread as it is drawn: oldest first, a heading whenever the day changes,
 * and each line told whether it starts a new run by the same speaker — so a
 * burst of four messages carries one name rather than four.
 */
export function thread<T extends { id: string; createdAt: string; ownerId?: string }>(items: readonly T[], speakerOf: (item: T) => string): ThreadRow<T>[] {
  const out: ThreadRow<T>[] = []
  let day = ''
  let speaker = ''
  for (const item of items) {
    const itsDay = item.createdAt.slice(0, 10)
    if (itsDay !== day) {
      out.push({ day: itsDay })
      day = itsDay
      // a new day always re-states who is talking
      speaker = ''
    }
    const who = speakerOf(item)
    out.push({ item, firstOfRun: who !== speaker })
    speaker = who
  }
  return out
}

/**
 * The conversation so far, as the assistant is reminded of it: the last few
 * turns, oldest first, each on one line. Only the words — a reference the
 * model made up earlier must not come back as though the planner had said it.
 */
export function recentContext(turns: readonly ChatTurn[], limit = CHAT_CONTEXT_TURNS): string[] {
  return turns
    .slice(-limit)
    .map(t => `${t.role === 'you' ? 'Them' : 'You'}: ${t.text.replace(/\s+/g, ' ').trim()}`)
    .filter(line => line.length > 5)
}

/**
 * Messages written since you last looked, by somebody else. `seenAt` is this
 * device's own mark (readChatSeen below), so a phone and a laptop each count
 * what that device has not shown you.
 */
export function unreadSince(messages: readonly Message[], seenAt: string | null, myId: string | null): number {
  // nothing marked yet: a first visit should not open with a badge on every
  // message the household has ever written
  if (!seenAt) return 0
  return messages.filter(m => m.createdAt > seenAt && (!myId || (!!m.ownerId && m.ownerId !== myId))).length
}

/**
 * The newest message this device has shown you. Kept on the device, not in a
 * record: a phone and a laptop each count what THEY have not put in front of
 * you, and a mark that synced would clear the badge on the wrong screen.
 */
const SEEN_KEY = 'drafter:chat-seen'

export function readChatSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    // private mode: every message reads as new, which is the safe way round
    return null
  }
}

export function writeChatSeen(at: string): void {
  try {
    localStorage.setItem(SEEN_KEY, at)
  } catch {
    /* ignore */
  }
}

/** What the composer offers as a starting point for the assistant. Questions it can actually answer from the planner. */
export const CHAT_PROMPTS = ['Tell me about my week', 'What is due for me tomorrow?', 'Who have I not seen lately?', 'What did I cook last week?']
