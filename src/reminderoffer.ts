import { isMineTask } from '../shared/domain.mts'
import { hasDueTime } from '../shared/due.mts'
import { isNative, localNotificationPermission, requestLocalNotificationPermission, setLocalRemindersEnabled } from './native'
import { OPEN_STATUSES, type Task } from './types'

// The iPhone asks whether Drafter may notify only when someone has done
// something a notification is for. It used to ask a second and a half after
// the planner first had data — Plan your day is on by default — so the alert
// came with nothing on screen to say what it was for. Now it is asked from
// the bell's Turn on, from Settings → Notifications, or here: the first time
// a task of mine is given a time to be due, with one line first saying what
// the answer is for, and a button to say yes to.

/** Set once the offer has been made on this phone: it is not made again, whatever the answer. */
export const REMINDER_OFFER_KEY = 'drafter:reminder-offer'

/** The one line before iOS's question. */
export const REMINDER_OFFER_LINE = 'Drafter can remind you on this iPhone when a task is due.'

/** The button that puts iOS's question. */
export const REMINDER_OFFER_BUTTON = 'Remind me'

/**
 * Whether saving `after` over `before` gives a task of mine a time to be due:
 * open, mine by the rule the phone reminds by (isMineTask), and a due time it
 * did not have. A day alone is left out — it is the time that says when.
 */
export function givesDueTime(before: Pick<Task, 'dueAt'> | undefined, after: Task, myId: string | null | undefined): boolean {
  if (!after.dueAt || !hasDueTime(after.dueAt) || !OPEN_STATUSES.includes(after.status) || !isMineTask(after, myId)) return false
  return before?.dueAt !== after.dueAt
}

function offeredHere(): boolean {
  try {
    return !!localStorage.getItem(REMINDER_OFFER_KEY)
  } catch {
    // nothing can be remembered here: offering on every save would nag, so never
    return true
  }
}

function rememberOffer(): void {
  try {
    localStorage.setItem(REMINDER_OFFER_KEY, new Date().toISOString())
  } catch {
    /* not offered again this session either: offeredHere reads true */
  }
}

/**
 * Whether to make the offer as `after` is saved, and if so, that it has been
 * made: in the app, the first time on this phone, while iOS has yet to be
 * asked at all. Asking is the button's job (allowDueReminders), never this.
 */
export async function takeReminderOffer(before: Pick<Task, 'dueAt'> | undefined, after: Task, myId: string | null | undefined): Promise<boolean> {
  if (!isNative() || !givesDueTime(before, after, myId) || offeredHere()) return false
  if ((await localNotificationPermission()) !== 'prompt') return false
  // looked at once more: two saves in a row must not both offer
  if (offeredHere()) return false
  rememberOffer()
  return true
}

/**
 * The offer's button: iOS's question, and on a yes this phone's reminders on
 * (Settings → Notifications → Remind me on this iPhone). The switch is on
 * before the question, so the reminders set on the yes include this task; a
 * no leaves it off again. Resolves whether iOS said yes.
 */
export async function allowDueReminders(): Promise<boolean> {
  setLocalRemindersEnabled(true)
  const ok = await requestLocalNotificationPermission().catch(() => false)
  if (!ok) setLocalRemindersEnabled(false)
  return ok
}
