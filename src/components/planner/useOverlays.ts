import { useEffect, useState } from 'react'
import type { AdminGroup } from '../../admin'
import type { CalendarEntry, CalendarEvent, Project, Task, WorkMode } from '../../types'
import type { PlanStep } from '../PlanDaySheet'

/**
 * The planning sheet over the screen. There is one slot, so opening a sheet
 * replaces whichever was up. Each kind is a render in Overlays.tsx inside its
 * own Layer and a chunk in lazy.ts: Plan my day, Shut down, Plan next week,
 * Ask Drafter (on the palette's Ask row's question, or empty), I'm here,
 * Who, and how often (the rhythms, on its People or Places side), and the
 * notification hub behind the bell on Home.
 */
export type Sheet =
  | { kind: 'day'; step?: PlanStep }
  | { kind: 'shutdown' }
  | { kind: 'week' }
  | { kind: 'ask'; question?: string }
  | { kind: 'imhere' }
  | { kind: 'rhythms'; side?: 'people' | 'places' }
  | { kind: 'notices' }

/**
 * A screen you go INTO and come back from, drawn over whichever tab you were
 * on. Settings, the chat and Admin are the three.
 *
 * Both were sheets that slid up over the page, and neither is a thing you
 * glance at: Settings is eight sections of prose and switches, the chat is a
 * conversation. A sheet gave each of them about two thirds of a screen to
 * scroll inside and left the tab underneath showing above it, cut off
 * mid-card — which is what it looks like when a place is dressed as a
 * glance. They are screens now, and they leave by the same ‹ back control
 * every other page the app opens uses.
 *
 * They are NOT tabs. A tab is somewhere you return to; these are somewhere
 * you go, do a thing, and leave. So they live here rather than in View, and
 * a tap on any tab drops them (goView).
 */
export type Pushed = 'settings' | 'chat' | 'admin'

/** What can sit over the screen — the editors, the palette, the sheets — and the ways to open them. */
export function useOverlays() {
  const [editor, setEditor] = useState<{ task?: Task; preset?: Partial<Task>; capture?: boolean } | null>(null)
  const [projectEditor, setProjectEditor] = useState<{ project: Project } | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /** The pushed screen up, if any: Settings or the chat. */
  const [pushed, setPushed] = useState<Pushed | null>(null)
  // bumped when a calendar consent flow returns, so an open Settings refetches
  const [settingsNonce, setSettingsNonce] = useState(0)
  /** The Settings group it opens on, when the opener asks for one (Today's calendar sign-in banner asks for Calendars). */
  const [settingsGroup, setSettingsGroup] = useState<string | undefined>(undefined)
  const openSettings = (group?: string) => {
    setSettingsGroup(group)
    setPushed('settings')
  }
  /** The Admin section it opens on: Users, unless the opener asks for another (Today's sync alarm asks for Data). */
  const [adminGroup, setAdminGroup] = useState<AdminGroup | undefined>(undefined)
  /** Admin is a pushed screen like the other two; four callers still say it this way. */
  const setAdminOpen = (open: boolean, group?: AdminGroup) => {
    setAdminGroup(group)
    setPushed(open ? 'admin' : null)
  }
  /** Which event the editor is on: an existing entry, or a new one at this instant. */
  const [eventEditor, setEventEditor] = useState<{ entry?: CalendarEntry; startIso: string; work?: WorkMode } | null>(null)
  const [attendance, setAttendance] = useState<CalendarEvent | null>(null)
  /** The planning sheet up, if any. */
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const openSheet = (s: Sheet) => setSheet(s)
  const closeSheet = () => setSheet(null)

  // Cmd/Ctrl+K opens search from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openTask = (task: Task) => setEditor({ task })
  const newTask = (preset?: Partial<Task>, opts?: { capture?: boolean }) =>
    setEditor({
      preset,
      capture: opts?.capture ?? !!(preset?.title || preset?.link),
    })
  // there is one ongoing project, edited from a calendar day and from search;
  // nothing opens the editor on a blank one to start a second
  const openProject = (project: Project) => setProjectEditor({ project })

  /**
   * Pull to refresh stands down while any of these owns the screen. A pushed
   * screen counts: Settings has nothing to refresh, and the chat scrolls
   * itself, which is the gesture pull-to-refresh would take.
   */
  const anyOpen = !!editor || !!projectEditor || !!eventEditor || !!attendance || !!sheet || searchOpen || !!pushed || trashOpen

  return {
    sheet,
    openSheet,
    closeSheet,
    editor,
    setEditor,
    projectEditor,
    setProjectEditor,
    trashOpen,
    setTrashOpen,
    searchOpen,
    setSearchOpen,
    pushed,
    setPushed,
    settingsNonce,
    setSettingsNonce,
    settingsGroup,
    setSettingsGroup,
    openSettings,
    setAdminOpen,
    adminGroup,
    eventEditor,
    setEventEditor,
    attendance,
    setAttendance,
    openTask,
    newTask,
    openProject,
    anyOpen,
  }
}
