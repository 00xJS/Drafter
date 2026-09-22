/**
 * Which of Home's sections are folded away.
 *
 * Home is one long scroll and not every part of it is worth the same to
 * everyone every day: Recently done is a comfort some days and noise on
 * others, Occasions matters in the week before a birthday and never in
 * between. Folding one shuts it to its heading, and the heading stays — a
 * section you cannot see is a section you forget you have.
 *
 * Per device and not synced. Whether Coming up is open is about the screen in
 * front of you, not about the account: a phone and a laptop are different
 * amounts of room, and a fold that travelled would close a section on one
 * because you closed it on the other.
 *
 * The greeting strip at the top has no fold. It is four tiles of one line
 * each and it IS the day — there is nothing there to get out of the way of.
 */
const KEY = 'drafter:home-folded'

export function readFolded(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function writeFolded(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    /* private mode, or storage full: the folds are a convenience, not state */
  }
}

/** The list with `id` folded or unfolded, whichever it is not. */
export const toggleFold = (ids: string[], id: string): string[] => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
