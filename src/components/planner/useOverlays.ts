import { useEffect, useState } from 'react'
import type { CalendarEntry, CalendarEvent, Project, Task, WorkMode } from '../../types'
import type { PlanStep } from '../PlanDaySheet'

/**
 * The planning sheet over the screen. There is one slot, so opening a sheet
 * replaces whichever was up. Each kind is a render in Overlays.tsx inside its
 * own Layer and a chunk in lazy.ts. Plan next week and Ask Drafter join the
 * union as `{ kind: 'week' }` and `{ kind: 'ask'; question?: string }`: a
 * member here, a render there, a chunk in lazy.ts, and whatever opens it.
 */
export type Sheet = { kind: 'day'; step?: PlanStep } | { kind: 'shutdown' }

/** What can sit over the screen — the editors, the palette, the sheets — and the ways to open them. */
export function useOverlays() {
  const [editor, setEditor] = useState<{ task?: Task; preset?: Partial<Task>; capture?: boolean } | null>(null)
  const [projectEditor, setProjectEditor] = useState<{ project?: Project } | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // bumped when a calendar consent flow returns, so an open Settings refetches
  const [settingsNonce, setSettingsNonce] = useState(0)
  const [adminOpen, setAdminOpen] = useState(false)
  /** Which event the editor is on: an existing entry, or a new one at this instant. */
  const [eventEditor, setEventEditor] = useState<{ entry?: CalendarEntry; startIso: string; work?: WorkMode } | null>(null)
  const [attendance, setAttendance] = useState<CalendarEvent | null>(null)
  /** Plan my day or Shut down; null when no planning sheet is up. */
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
  const openProject = (project: Project) => setProjectEditor({ project })
  const newProject = () => setProjectEditor({})

  /** Pull to refresh stands down while any of these owns the screen. */
  const anyOpen = !!editor || !!projectEditor || !!eventEditor || !!attendance || !!sheet || searchOpen || settingsOpen || trashOpen || adminOpen

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
    settingsOpen,
    setSettingsOpen,
    settingsNonce,
    setSettingsNonce,
    adminOpen,
    setAdminOpen,
    eventEditor,
    setEventEditor,
    attendance,
    setAttendance,
    openTask,
    newTask,
    openProject,
    newProject,
    anyOpen,
  }
}
