import { useEffect } from 'react'
import { preloadable, schedulePreload, warm } from '../../lazyload'
import type { View } from './routes'

// Everything a launch does not paint first, each in a chunk of its own: the
// views behind the other tabs and segments, and every overlay. Today (with its
// journal card), the header, the toast and the error boundary stay in the
// Planner chunk. The shell and the screens import these, never the files
// themselves (lazyload.test.ts walks the imports to hold that, and
// scripts/check-precache.mjs checks the built launch holds no assistant code).
export const Calendar = preloadable(() => import('../Calendar').then(m => m.Calendar), 'Calendar')
export const Roadmap = preloadable(() => import('../Roadmap').then(m => m.Roadmap), 'Roadmap')
export const TasksTable = preloadable(() => import('../TasksTable').then(m => m.TasksTable), 'TasksTable')
export const Board = preloadable(() => import('../Board').then(m => m.Board), 'Board')
// Tasks → Finance: the month of bills, the paydays and the accounts. Bills.tsx
// is drawn inside it, so the two share one chunk rather than shipping twice.
export const Finance = preloadable(() => import('../Finance').then(m => m.Finance), 'Finance')
export const NotesView = preloadable(() => import('../NotesView').then(m => m.NotesView), 'NotesView')
export const People = preloadable(() => import('../People').then(m => m.People), 'People')
export const Places = preloadable(() => import('../Places').then(m => m.Places), 'Places')
// People → People's Stats and People → Places' Stats, behind each segment's
// List · Stats switch, each with the counting only it reads (peoplestats.ts,
// placestats.ts) in a chunk of its own
export const PeopleStats = preloadable(() => import('../PeopleStats').then(m => m.PeopleStats), 'PeopleStats')
export const PlacesStats = preloadable(() => import('../PlacesStats').then(m => m.PlacesStats), 'PlacesStats')
export const Kitchen = preloadable(() => import('../Kitchen').then(m => m.Kitchen), 'Kitchen')
// Kitchen → Stats and the Stats kit it draws with: a chunk of its own, which
// the Kitchen imports from here and a finger on the Kitchen tab warms too
export const KitchenStats = preloadable(() => import('../kitchen/KitchenStats').then(m => m.KitchenStats), 'KitchenStats')
export const Review = preloadable(() => import('../Review').then(m => m.Review), 'Review')
// Insights → Journal: the archive of what you wrote, with its mood chart and
// its search. Writing today's line is Today's, and that card and the editor it
// writes with stay in the Planner chunk (JournalCard.tsx).
export const JournalView = preloadable(() => import('../Journal').then(m => m.JournalView), 'JournalView')
// Home → Chat: the household's thread and the assistant's, and the retrieval
// the assistant runs on this device (ask.ts) — the biggest module either of
// them touches, and one nobody who never opens the chat should download.
export const Chat = preloadable(() => import('../Chat').then(m => m.Chat), 'Chat')
// Home → Wardrobe: the composer, the clothes, the stats and the piece sheet.
// Only Today's card and the thumbnails it draws stay in the Planner chunk.
export const Wardrobe = preloadable(() => import('../wardrobe/Wardrobe').then(m => m.Wardrobe), 'Wardrobe')
// …and the wardrobe's figures on their own, because the Stats lens draws them
// too and must not drag the composer, the clothes grid and the photo pipeline
// in behind them. Wardrobe.tsx still imports the view directly, so the two
// share one chunk rather than shipping it twice.
export const WardrobeStats = preloadable(() => import('../wardrobe/WardrobeStats').then(m => m.WardrobeStats), 'WardrobeStats')
// The Stats lens: the tab's own segments (Overview, Tasks, Money, Habits,
// Journal) and the counting only it reads (lensstats.ts). The four areas that
// keep Stats of their own are drawn from THEIR chunks, above — one view, one
// chunk, wherever it is shown.
export const StatsLens = preloadable(() => import('../StatsLens').then(m => m.StatsLens), 'StatsLens')

export const TaskEditor = preloadable(() => import('../TaskEditor').then(m => m.TaskEditor), 'TaskEditor')
export const ProjectEditor = preloadable(() => import('../ProjectEditor').then(m => m.ProjectEditor), 'ProjectEditor')
export const EventEditor = preloadable(() => import('../EventEditor').then(m => m.EventEditor), 'EventEditor')
export const AttendancePicker = preloadable(() => import('../AttendancePicker').then(m => m.AttendancePicker), 'AttendancePicker')
export const Search = preloadable(() => import('../Search').then(m => m.Search), 'Search')
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
export const NoticesSheet = preloadable(() => import('../NoticesSheet').then(m => m.NoticesSheet), 'NoticesSheet')

/** What each tab can show, so a finger landing on it starts the fetch before the tap completes. */
const VIEW_CHUNKS: Record<View, (() => Promise<void>)[]> = {
  home: [Review.preload, Chat.preload, PlanDaySheet.preload, ShutdownSheet.preload, WeekPlanSheet.preload, NoticesSheet.preload],
  tasks: [TasksTable.preload, Board.preload, Finance.preload, NotesView.preload],
  calendar: [Calendar.preload, Roadmap.preload],
  // four segments, and a finger cannot say which — so all four, as the lens does
  keep: [People.preload, Places.preload, PeopleStats.preload, PlacesStats.preload, ImHereSheet.preload, RhythmSheet.preload, Kitchen.preload, KitchenStats.preload, Wardrobe.preload],
  // the lens draws every area's Stats, so a finger on it warms all of them
  insights: [StatsLens.preload, PeopleStats.preload, PlacesStats.preload, KitchenStats.preload, WardrobeStats.preload, JournalView.preload, Review.preload],
}
export const preloadView = (v: View) => warm(...VIEW_CHUNKS[v])

/** The background warm-up, most-opened first. Admin is not in it: only the
 *  owner fetches that chunk.
 *
 *  Settings and the chat sit near the front because the top bar reaches both
 *  from every screen — Settings was dead last of 29, from when it was a dialog
 *  you rarely opened rather than a screen you navigate to. */
export const PRELOAD_ORDER = [TaskEditor, Search, Settings, Chat, NoticesSheet, PlanDaySheet, ShutdownSheet, WeekPlanSheet, AskSheet, ImHereSheet, RhythmSheet, Calendar, TasksTable, Board, Roadmap, Finance, NotesView, People, Places, PeopleStats, PlacesStats, Kitchen, KitchenStats, StatsLens, Review, JournalView, Wardrobe, WardrobeStats, ProjectEditor, EventEditor, AttendancePicker, Trash].map(c => c.preload)

/** A moment after launch, fetch every lazy chunk in the background; Admin's only for the owner. */
export function useWarmChunks(isOwner: boolean) {
  useEffect(() => schedulePreload(PRELOAD_ORDER), [])
  useEffect(() => {
    if (isOwner) warm(Admin.preload)
  }, [isOwner])
}
