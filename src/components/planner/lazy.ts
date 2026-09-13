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
export const Kitchen = preloadable(() => import('../Kitchen').then(m => m.Kitchen), 'Kitchen')
export const Review = preloadable(() => import('../Review').then(m => m.Review), 'Review')

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

/** What each tab can show, so a finger landing on it starts the fetch before the tap completes. */
const VIEW_CHUNKS: Record<View, (() => Promise<void>)[]> = {
  home: [Review.preload, PlanDaySheet.preload, ShutdownSheet.preload],
  tasks: [TasksTable.preload, Board.preload, Bills.preload, NotesView.preload],
  calendar: [Calendar.preload, Roadmap.preload],
  people: [People.preload, Places.preload],
  kitchen: [Kitchen.preload],
}
export const preloadView = (v: View) => warm(...VIEW_CHUNKS[v])

/** The background warm-up, most-opened first. Admin is not in it: only the owner fetches that chunk. */
export const PRELOAD_ORDER = [TaskEditor, Search, PlanDaySheet, ShutdownSheet, Calendar, TasksTable, Board, Roadmap, Bills, NotesView, People, Places, Kitchen, Review, ProjectEditor, EventEditor, AttendancePicker, Trash, Settings].map(c => c.preload)

/** A moment after launch, fetch every lazy chunk in the background; Admin's only for the owner. */
export function useWarmChunks(isOwner: boolean) {
  useEffect(() => schedulePreload(PRELOAD_ORDER), [])
  useEffect(() => {
    if (isOwner) warm(Admin.preload)
  }, [isOwner])
}
