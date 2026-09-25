import { VIEWS, type View } from './components/planner/routes'
import { isNative } from './native'

// iOS takes an idle app's web content back — after the full-screen camera, or
// a while in the background — and Capacitor reloads the page into the same web
// view. The planner then came back on Home, whatever tab it had been on. The
// tab is kept in sessionStorage, which belongs to the web view: a launch starts
// with none, and a reload into the same web view keeps it. So a tab kept is
// itself the sign of a reload. The page's navigation entry is not asked: after
// the web content is reclaimed, WebKit loads the page anew in a new process and
// does not call that a reload. A reload asked for (the error screen's, a
// sign-out's) forgets the tab first. The segment inside each tab is already
// kept, in localStorage (routes.ts). The iOS shell only: in a browser a reload
// is the reader's own, and starts where they put it.

/** sessionStorage: the tab on screen, in the shell. */
export const RELOAD_VIEW_KEY = 'drafter:reload-view'

/** The tab to open on: after iOS reclaimed the page, the one it was on; otherwise Home. */
export function restoredView(): View {
  if (!isNative()) return 'home'
  try {
    const saved = sessionStorage.getItem(RELOAD_VIEW_KEY)
    return saved && (VIEWS as string[]).includes(saved) ? (saved as View) : 'home'
  } catch {
    return 'home'
  }
}

/** The tab now on screen, for the reload that may come. */
export function rememberView(view: View): void {
  if (!isNative()) return
  try {
    sessionStorage.setItem(RELOAD_VIEW_KEY, view)
  } catch {
    /* not kept: a reload opens on Home, as it always did */
  }
}

/**
 * A reload asked for — the error screen's Reload, a sign-out — opens on Home:
 * the screen that broke is not the one to come back to, and the next account
 * starts where every account does.
 */
export function forgetView(): void {
  try {
    sessionStorage.removeItem(RELOAD_VIEW_KEY)
  } catch {
    /* nothing kept to forget */
  }
}
