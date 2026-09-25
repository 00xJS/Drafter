import { useEffect } from 'react'
import { preloadable, schedulePreload, warm, withSheet } from '../../lazyload'
import { isNative } from '../../native'
import { KitchenStats, PeopleStats, PlacesStats, WardrobeStats } from './lazystats'
import type { View } from './routes'

// the four areas' Stats, in a registry of their own that the Kitchen and the Stats lens import too
export { KitchenStats, PeopleStats, PlacesStats, WardrobeStats }

// Everything a launch does not paint first, each in a chunk of its own: the
// views behind the other tabs and segments, and every overlay. Today (with its
// journal card), the header, the toast and the error boundary stay in the
// Planner chunk. The shell and the screens import these, never the files
// themselves (lazyload.test.ts walks the imports to hold that, and
// scripts/check-precache.mjs checks the built launch holds no assistant code).
export const Calendar = preloadable(() => withSheet(import('../Calendar'), import('../../styles/views/calendar.css')).then(m => m.Calendar), 'Calendar')
export const TasksTable = preloadable(() => withSheet(import('../TasksTable'), import('../../styles/views/tasks-table.css')).then(m => m.TasksTable), 'TasksTable')
export const Board = preloadable(() => import('../Board').then(m => m.Board), 'Board')
// Tasks → Finance: the month of bills, the paydays and the accounts. Bills.tsx
// is drawn inside it, so the two share one chunk rather than shipping twice.
export const Finance = preloadable(() => withSheet(import('../Finance'), import('../../styles/views/finance.css')).then(m => m.Finance), 'Finance')
export const NotesView = preloadable(() => withSheet(import('../NotesView'), import('../../styles/views/notes.css')).then(m => m.NotesView), 'NotesView')
export const People = preloadable(() => import('../People').then(m => m.People), 'People')
export const Places = preloadable(() => import('../Places').then(m => m.Places), 'Places')
export const Kitchen = preloadable(() => withSheet(import('../Kitchen'), import('../../styles/views/kitchen.css')).then(m => m.Kitchen), 'Kitchen')
export const Review = preloadable(() => withSheet(import('../Review'), import('../../styles/views/review.css')).then(m => m.Review), 'Review')
// Insights → Journal: the archive of what you wrote, with its mood chart and
// its search. Writing today's line is Today's, and that card and the editor it
// writes with stay in the Planner chunk (JournalCard.tsx).
export const JournalView = preloadable(() => withSheet(import('../Journal'), import('../../styles/views/journal.css')).then(m => m.JournalView), 'JournalView')
// Home → Chat: the household's thread and the assistant's, and the retrieval
// the assistant runs on this device (ask.ts) — the biggest module either of
// them touches, and one nobody who never opens the chat should download.
export const Chat = preloadable(() => withSheet(import('../Chat'), import('../../styles/views/chat.css')).then(m => m.Chat), 'Chat')
// Home → Wardrobe: the composer, the clothes, the stats and the piece sheet.
// Only Today's card and the thumbnails it draws stay in the Planner chunk.
export const Wardrobe = preloadable(() => withSheet(import('../wardrobe/Wardrobe'), import('../../styles/views/wardrobe.css')).then(m => m.Wardrobe), 'Wardrobe')
// The Stats lens: Insights' Highlights (components/insights, and the rules
// they pick by, shared/insights.mts), the pages the lens counts itself —
// Tasks, Money, Habits, Journal and the year — and the counting only it reads
// (lensstats.ts). The four areas that keep Stats of their own are drawn from
// THEIR chunks, above — one view, one chunk, wherever it is shown.
export const StatsLens = preloadable(() => withSheet(import('../StatsLens'), import('../../styles/views/stats-lens.css')).then(m => m.StatsLens), 'StatsLens')

export const TaskEditor = preloadable(() => withSheet(import('../TaskEditor'), import('../../styles/views/task-editor.css')).then(m => m.TaskEditor), 'TaskEditor')
export const ProjectEditor = preloadable(() => import('../ProjectEditor').then(m => m.ProjectEditor), 'ProjectEditor')
export const EventEditor = preloadable(() => import('../EventEditor').then(m => m.EventEditor), 'EventEditor')
export const AttendancePicker = preloadable(() => import('../AttendancePicker').then(m => m.AttendancePicker), 'AttendancePicker')
export const Search = preloadable(() => withSheet(import('../Search'), import('../../styles/views/search.css')).then(m => m.Search), 'Search')
export const Trash = preloadable(() => import('../Trash').then(m => m.Trash), 'Trash')
export const Settings = preloadable(() => import('../Settings').then(m => m.Settings), 'Settings')
export const Admin = preloadable(() => import('../Admin').then(m => m.Admin), 'Admin')
// the daily routines' sheets, opened from Today's strip, the palette and ?plan=
export const PlanDaySheet = preloadable(() => import('../PlanDaySheet').then(m => m.PlanDaySheet), 'PlanDaySheet')
export const ShutdownSheet = preloadable(() => import('../ShutdownSheet').then(m => m.ShutdownSheet), 'ShutdownSheet')
// Plan next week (Home → Week, Today on a Sunday, the palette, ?plan=week) and Ask Drafter (the palette)
export const WeekPlanSheet = preloadable(() => import('../WeekPlanSheet').then(m => m.WeekPlanSheet), 'WeekPlanSheet')
export const AskSheet = preloadable(() => import('../AskSheet').then(m => m.AskSheet), 'AskSheet')
export const ImHereSheet = preloadable(() => import('../ImHereSheet').then(m => m.ImHereSheet), 'ImHereSheet')
// Who, and how often: Today's cold-start card and the People and Places rows open it
export const RhythmSheet = preloadable(() => import('../RhythmSheet').then(m => m.RhythmSheet), 'RhythmSheet')
// The notification hub, behind the bell on Home: only the bell is in the launch
export const NoticesSheet = preloadable(() => withSheet(import('../NoticesSheet'), import('../../styles/views/notices.css')).then(m => m.NoticesSheet), 'NoticesSheet')

/** What each tab can show, so a finger landing on it starts the fetch before the tap completes. */
const VIEW_CHUNKS: Record<View, (() => Promise<void>)[]> = {
  home: [Review.preload, Chat.preload, PlanDaySheet.preload, ShutdownSheet.preload, WeekPlanSheet.preload, NoticesSheet.preload],
  tasks: [TasksTable.preload, Board.preload, Finance.preload, NotesView.preload],
  calendar: [Calendar.preload],
  // four segments, and a finger cannot say which — so all four, as the lens does
  keep: [People.preload, Places.preload, PeopleStats.preload, PlacesStats.preload, ImHereSheet.preload, RhythmSheet.preload, Kitchen.preload, KitchenStats.preload, Wardrobe.preload],
  // the lens draws every area's Stats, so a finger on it warms all of them
  insights: [StatsLens.preload, PeopleStats.preload, PlacesStats.preload, KitchenStats.preload, WardrobeStats.preload, JournalView.preload, Review.preload],
}
export const preloadView = (v: View) => warm(...VIEW_CHUNKS[v])

/** The background warm-up on the web, most-opened first. Admin is not in it:
 *  only the owner fetches that chunk.
 *
 *  Settings sits near the front because the top bar reaches it from every
 *  screen — it was dead last of 29, from when it was a dialog you rarely
 *  opened rather than a screen you navigate to. The assistant's own views,
 *  the chat and Ask, come last: theirs is the most code to parse (the chat's
 *  actions, the retrieval Ask runs), it was parsed at the front while the
 *  first sync ran, and a finger on the chat's button or the Home tab warms
 *  them anyway. */
export const PRELOAD_ORDER = [TaskEditor, Search, Settings, NoticesSheet, PlanDaySheet, ShutdownSheet, WeekPlanSheet, ImHereSheet, RhythmSheet, Calendar, TasksTable, Board, Finance, NotesView, People, Places, PeopleStats, PlacesStats, Kitchen, KitchenStats, StatsLens, Review, JournalView, Wardrobe, WardrobeStats, ProjectEditor, EventEditor, AttendancePicker, Trash, Chat, AskSheet].map(c => c.preload)

/** The warm-up in the iOS app: what the top bar opens from every screen, and nothing else. */
export const NATIVE_PRELOAD_ORDER = [TaskEditor, Search, Settings].map(c => c.preload)

/**
 * Which warm-up a launch runs. On the web every chunk is a download the next
 * tap would otherwise wait on. In the iOS app the bundle is already on disk,
 * so fetching saves nothing: all the warm-up bought was every view's code
 * parsed on the main thread while the first sync ran. There the rest wait for
 * a finger on their tab or button (preloadView, the top bar's warms), which
 * is soon enough to beat the tap.
 */
export const preloadOrder = (native: boolean): readonly (() => Promise<void>)[] => (native ? NATIVE_PRELOAD_ORDER : PRELOAD_ORDER)

/** A moment after launch, warm the chunks this launch wants (preloadOrder); on the web, Admin's too for the owner. */
export function useWarmChunks(isOwner: boolean) {
  useEffect(() => schedulePreload(preloadOrder(isNative())), [])
  useEffect(() => {
    // in the app its code is on disk, and parsed when the owner opens it
    if (isOwner && !isNative()) warm(Admin.preload)
  }, [isOwner])
}
