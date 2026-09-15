import { useEffect } from 'react'
import { preloadable, schedulePreload, warm } from '../../lazyload'
import type { View } from './routes'

// Everything a launch does not paint first, each in a chunk of its own: the
// views behind the other tabs and segments, and every overlay. Today, the
// Journal, the header, the toast and the error boundary stay in the Planner
// chunk. The shell and the screens import these, never the files themselves
// (lazyload.test.ts walks the imports to hold that).
export const Calendar = preloadable(() => import('../Calendar').then(m => m.Calendar), 'Calendar')
export const Roadmap = preloadable(() => import('../Roadmap').then(m => m.Roadmap), 'Roadmap')
export const TasksTable = preloadable(() => import('../TasksTable').then(m => m.TasksTable), 'TasksTable')
export const Board = preloadable(() => import('../Board').then(m => m.Board), 'Board')
export const Bills = preloadable(() => import('../Bills').then(m => m.Bills), 'Bills')
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
// Home → Wardrobe: the composer, the clothes, the stats and the piece sheet.
// Only Today's card and the thumbnails it draws stay in the Planner chunk.
export const Wardrobe = preloadable(() => import('../wardrobe/Wardrobe').then(m => m.Wardrobe), 'Wardrobe')

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

/** What each tab can show, so a finger landing on it starts the fetch before the tap completes. */
const VIEW_CHUNKS: Record<View, (() => Promise<void>)[]> = {
  home: [Review.preload, Wardrobe.preload, PlanDaySheet.preload, ShutdownSheet.preload, WeekPlanSheet.preload],
  tasks: [TasksTable.preload, Board.preload, Bills.preload, NotesView.preload],
  calendar: [Calendar.preload, Roadmap.preload],
  people: [People.preload, Places.preload, PeopleStats.preload, PlacesStats.preload],
  kitchen: [Kitchen.preload, KitchenStats.preload],
}
export const preloadView = (v: View) => warm(...VIEW_CHUNKS[v])

/** The background warm-up, most-opened first. Admin is not in it: only the owner fetches that chunk. */
export const PRELOAD_ORDER = [TaskEditor, Search, PlanDaySheet, ShutdownSheet, WeekPlanSheet, AskSheet, Calendar, TasksTable, Board, Roadmap, Bills, NotesView, People, Places, PeopleStats, PlacesStats, Kitchen, KitchenStats, Review, Wardrobe, ProjectEditor, EventEditor, AttendancePicker, Trash, Settings].map(c => c.preload)

/** A moment after launch, fetch every lazy chunk in the background; Admin's only for the owner. */
export function useWarmChunks(isOwner: boolean) {
  useEffect(() => schedulePreload(PRELOAD_ORDER), [])
  useEffect(() => {
    if (isOwner) warm(Admin.preload)
  }, [isOwner])
}
