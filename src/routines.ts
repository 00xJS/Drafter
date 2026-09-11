import { Routine, RoutineStep, RoutineWhen } from './types'
import { uid } from './utils'

// The rules a routine runs by. A tick is 'day|stepId' on the record, so
// "today's progress" is just the ticks that name today — there is no reset job
// and nothing to clear at midnight; a new day has no ticks yet and starts fresh.

export function tickKey(day: string, stepId: string): string {
  return `${day}|${stepId}`
}

export function isStepDone(routine: Routine, day: string, stepId: string): boolean {
  return routine.ticks.includes(tickKey(day, stepId))
}

/** Tick or un-tick a step for a day, returning the updated record (sorted, de-duped). */
export function toggleStep(routine: Routine, day: string, stepId: string, now = new Date().toISOString()): Routine {
  const key = tickKey(day, stepId)
  const ticks = routine.ticks.includes(key) ? routine.ticks.filter(t => t !== key) : [...routine.ticks, key].sort()
  return { ...routine, ticks, updatedAt: now }
}

/** How far through the routine you are on a day. Counts only steps that still
 *  exist, so an orphaned tick from a deleted step never shows as 3/2. */
export function progressOn(routine: Routine, day: string): { done: number; total: number } {
  const done = routine.steps.filter(s => routine.ticks.includes(tickKey(day, s.id))).length
  return { done, total: routine.steps.length }
}

/** Which routines belong to this hour: morning before 12:00, evening from
 *  17:00, anytime always. The afternoon shows only anytime — a morning list at
 *  three o'clock is a nag, not a prompt. */
export function whichToShow(hour: number): Set<RoutineWhen> {
  const show = new Set<RoutineWhen>(['anytime'])
  if (hour < 12) show.add('morning')
  if (hour >= 17) show.add('evening')
  return show
}

export function stepsToText(steps: RoutineStep[]): string {
  return steps.map(s => s.text).join('\n')
}

/**
 * Steps from the "one per line" textarea. A line that matches a previous
 * step's text keeps that step's id, so reordering or rewording one line does
 * not wipe today's ticks on the others; each previous id is reused at most
 * once, so two identical lines get two steps. `mint` is injectable for tests.
 */
export function stepsFromText(text: string, prev: RoutineStep[] = [], mint: () => string = uid): RoutineStep[] {
  const unclaimed = [...prev]
  const out: RoutineStep[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const i = unclaimed.findIndex(s => s.text === line)
    if (i >= 0) {
      out.push(unclaimed[i])
      unclaimed.splice(i, 1)
    } else {
      out.push({ id: mint(), text: line })
    }
  }
  return out
}
